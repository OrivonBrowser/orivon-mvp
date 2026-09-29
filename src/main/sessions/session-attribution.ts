// Publishes ctx.senderAttributed (registry.ts) -- the one answer to "is this
// WebContents attributed to this origin" every renderer-reachable broker
// channel needs before it may trust a frame's own claimed origin. Split into
// its own subsystem, listed before brokerIpcSubsystem in subsystems.ts,
// because the broker itself cannot compute this answer: it needs the
// loader's bundle-cache state (isOriginServedFromCacheSync), and
// src/broker/ must never import src/loader/ (../../broker/README.md).
// ../shell/tab-view.ts's partitionForTarget already combines the same two
// facts for a navigating tab; this reuses it rather than re-deriving the
// rule a second time.
//
// ATTRIBUTION IS DECIDED AT COMMIT, NOT RE-DECIDED UNDER A LIVE DOCUMENT.
// Checking a document's LIVE session against what its origin currently
// expects (the only thing the previous version of this file did) strands a
// document the instant a grant or a revoke moves that expectation: an app
// that just lost its only grant is denied even `app.requestGrant` from the
// tab it is already showing in, and a second tab of the same app is denied
// outright the moment the first one is granted, because neither tab's
// WebContents ever moves on its own. Recording what a document's session
// was found to be AT ITS OWN COMMIT, and trusting that record afterward,
// is what lets an already-attributed document keep calling successfully
// until it next navigates -- the same navigation that already triggers
// tab-view.ts's own partition swap for any other cross-origin move.
import { app, session } from 'electron'
import type { WebContents } from 'electron'
import type { Subsystem, SubsystemContext } from '../registry.js'
import { publishSenderAttributed } from '../registry.js'
import { partitionForTarget } from '../shell/tab-view.js'
import { originFromUrl } from '../../broker/policy/origin.js'
import { partitionFor } from '../../broker/grants/origin-hash.js'
import { isOriginServedFromCacheSync } from '../../loader/electron/serve.js'

interface AttributionRecord {
  readonly origin: string | null
  readonly attributed: boolean
}

/**
 * One record per WebContents, holding only what its OWN last main-frame
 * commit found true -- never updated except by that WebContents' own next
 * `did-navigate`, so a grant or a revoke that changes what a DIFFERENT
 * origin, or this same origin's NEXT document, would find never touches an
 * already-committed record.
 *
 * RESIDUAL: IPC from a newly-committed document can in principle arrive
 * before its own `did-navigate` is processed (both cross the same event
 * loop, but nothing orders one strictly before the other), so a same-origin
 * reload right after a grant change can briefly be answered by the
 * PREVIOUS document's record instead of its own. It matters only for an
 * origin not served from cache -- one that is served from cache is checked
 * live below, never through this map -- and only until that document's own
 * `did-navigate` lands, since both documents are running the same origin
 * on the same live code either way.
 */
const attributionRecords = new WeakMap<WebContents, AttributionRecord>()

export const sessionAttributionSubsystem: Subsystem = {
  name: 'session-attribution',
  afterReady: (ctx: SubsystemContext) => {
    // `ctx` is captured, not `ctx.broker` -- this runs before
    // brokerIpcSubsystem publishes it, and the closure below is only ever
    // called later, once a real request needs an answer, by which point it
    // is there.
    const expectedSession = (origin: string): unknown => {
      const partition = partitionForTarget(origin, ctx.broker)
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
        const origin = originFromUrl(url)
        attributionRecords.set(wc, {
          origin,
          attributed: origin !== null && wc.session === expectedSession(origin)
        })
      })
    })

    publishSenderAttributed(ctx, (sender, origin) => {
      const wc = sender as WebContents
      // Cache-served origins are checked LIVE and STRICTLY, never through a
      // record: a pinned app's own bundle is only ever intercepted inside
      // its own partition (ADR-0007), so a document attributed to it must
      // run there at every call, not merely at whatever moment it committed.
      if (isOriginServedFromCacheSync(origin)) {
        return wc.session === session.fromPartition(partitionFor(origin))
      }
      const record = attributionRecords.get(wc)
      if (record !== undefined && record.origin === origin) return record.attributed
      // No record yet (a call arriving before this WebContents' first
      // did-navigate, or one this subsystem never saw) -- the live check,
      // today's original rule, is the fallback.
      return wc.session === expectedSession(origin)
    })
  }
}
