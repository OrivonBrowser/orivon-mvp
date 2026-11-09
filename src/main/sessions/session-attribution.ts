// Publishes ctx.senderAttributed (registry.ts) -- the one answer to "is this
// WebContents attributed to this origin" every renderer-reachable broker
// channel needs before it may trust a frame's own claimed origin. Split into
// its own subsystem, listed before brokerIpcSubsystem in subsystems.ts,
// because the broker itself cannot compute this answer: it needs the
// loader's bundle-cache state (isOriginServedFromCacheSync), and
// src/broker/ must never import src/loader/ (../../broker/README.md).
// ../shell/tab-partition.ts's partitionForTab already decides the same thing
// for a navigating tab (a cache-served origin's own partition or, for a host
// the verifier hands to the shell, the default session; the default session
// for every other origin, granted or not: ADR-0044); this reuses it
// rather than re-deriving the rule a second time.
//
// Why attribution is decided at a document's own commit, never re-decided
// under a live document: README.md's Design notes.
import { app, session } from 'electron'
import type { WebContents } from 'electron'
import type { Subsystem, SubsystemContext } from '../registry.js'
import { publishSenderAttributed } from '../registry.js'
import { partitionForTab } from '../shell/tab-partition.js'
import { tabChoiceOfContents } from '../route/tab-tunnel.js'
import { isChildHostFor } from '../children/child-host.js'
import { isLocalFileKey, isolationKeyFromUrl } from '../../broker/policy/origin.js'
import { localPartitionFor } from '../local-files/partition.js'
import { isOriginServedFromCacheSync } from '../../loader/electron/serve.js'
import { runsAsWebsite } from '../shell/app-session.js'

interface AttributionRecord {
  readonly origin: string | null
  readonly attributed: boolean
  /** Whether the shell served the origin from a copy it keeps when this document committed: before that, the document came from the network. */
  readonly servedAtCommit: boolean
}

/**
 * One record per WebContents, holding only what its OWN last main-frame
 * commit found true -- never updated except by that WebContents' own next
 * `did-navigate`, so an origin leaving the pinned cache (an uninstall),
 * which changes what this same origin's NEXT document would find, never
 * touches an already-committed record.
 *
 * RESIDUAL: IPC from a newly-committed document can in principle arrive
 * before its own `did-navigate` is processed (both cross the same event
 * loop, but nothing orders one strictly before the other), so a same-origin
 * reload right after its origin leaves the pinned cache can briefly be
 * answered by the PREVIOUS document's record instead of its own. It matters
 * only for an origin not served from cache -- one that is served from cache
 * is checked live below, never through this map -- and only until that
 * document's own `did-navigate` lands, since both documents are running the
 * same origin on the same live code either way.
 */
const attributionRecords = new WeakMap<WebContents, AttributionRecord>()

export const sessionAttributionSubsystem: Subsystem = {
  name: 'session-attribution',
  afterReady: (ctx: SubsystemContext) => {
    // The session `wc`'s tab puts `origin` in: a tab with a tunnel choice puts every website in its profile.
    const expectedSession = (origin: string, wc: WebContents): unknown => {
      const partition = partitionForTab(origin, tabChoiceOfContents(wc.id))
      return partition === undefined ? session.defaultSession : session.fromPartition(partition)
    }

    // Fires for every WebContents Electron ever creates (tabs, popups,
    // embed guests, isolated web contexts), synchronously during its own
    // construction -- BEFORE tab-view.ts's wireView() can attach its own
    // did-navigate handler to the same WebContents, since that call happens
    // only after construction returns. Registration order is firing order
    // for listeners on the same event, so this always records a wrong-
    // session commit before tab-view.ts's own did-navigate handler swaps
    // the view out from under it. Moving this subsystem's position in
    // subsystems.ts does not change this: it is `web-contents-created`
    // firing early that matters, not afterReady's own ordering.
    app.on('web-contents-created', (_createdEvent, wc) => {
      wc.on('did-navigate', (_navEvent, url) => {
        const origin = isolationKeyFromUrl(url)
        attributionRecords.set(wc, {
          origin,
          attributed: origin !== null && wc.session === expectedSession(origin, wc),
          servedAtCommit: origin !== null && isOriginServedFromCacheSync(origin)
        })
      })
    })

    const committedBeforeServed = (wc: WebContents, origin: string): boolean => {
      const record = attributionRecords.get(wc)
      return record !== undefined && record.origin === origin && !record.servedAtCommit
    }

    publishSenderAttributed(ctx, (sender, origin) => {
      const wc = sender as WebContents
      // A local file is checked live and strictly, like a cache-served origin: a document's path is
      // fixed for its life (a same-document navigation cannot change it), so only the session can be
      // wrong, and it must be the one `localPartitionFor` names at this call. A record removed since the
      // commit therefore denies the document at once.
      if (isLocalFileKey(origin)) {
        const partition = localPartitionFor(origin)
        return partition !== undefined && wc.session === session.fromPartition(partition)
      }
      // An app's own child host (ADR-0046) runs in a session of its own by design.
      if (isChildHostFor(wc, origin)) return true
      // Cache-served origins are checked LIVE and STRICTLY, never through a
      // record: the session they run in is the one `partitionForTab` names at
      // this call. An app on a partition of its own is only ever intercepted
      // there (ADR-0007). An app the verifier hands to the shell runs in the
      // default session and is never attributed in the partition it had
      // before, but its document must also have been answered by the shell:
      // one that committed before the app was served came from the network,
      // and the grants the app holds now do not reach it (README.md's Design notes).
      if (isOriginServedFromCacheSync(origin)) {
        if (runsAsWebsite(origin) && committedBeforeServed(wc, origin)) return false
        return wc.session === expectedSession(origin, wc)
      }
      const record = attributionRecords.get(wc)
      if (record !== undefined && record.origin === origin) return record.attributed
      // No record yet (a call arriving before this WebContents' first
      // did-navigate, or one this subsystem never saw) -- the live check,
      // today's original rule, is the fallback.
      return wc.session === expectedSession(origin, wc)
    })
  }
}
