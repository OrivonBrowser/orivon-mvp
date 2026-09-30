// ADR-0039's Electron half: turns a `<webview>` attaching inside an app tab
// into a page the app is allowed to show, and keeps it that way. Every
// decision is ./embed-guard.ts's, and what the app is told of a popup or a
// download (ADR-0047) is ./embed-events.ts's; this file is what Electron calls.
//
// Attached through `app.on('web-contents-created')` rather than in
// tab-view.ts's per-view wiring, for the reason permission-gate.ts gives
// for sessions: the event reaches every WebContents this process ever
// makes, so a popup adopted as a tab, or a view a later stream builds, is
// covered without remembering to wire it.

import { app, session as electronSession } from 'electron'
import type { Session, WebContents, WebFrameMain } from 'electron'
import { join } from 'node:path'
import type { Broker } from '../../broker/broker-contracts.js'
import { originFromUrl } from '../../broker/policy/origin.js'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { requestPartition, withPartition } from '../verifier/partition.js'
import { EMBED_EVENT_CHANNEL } from '../channels.js'
import type { EmbedDownload, EmbedPopup } from '../../contracts/index.js'
import { embedPartitionFor, guestRequestAllowed, hardenGuest } from './embed-guard.js'
import { downloadDetail, popupDetail } from './embed-events.js'
import { devModeEnabled } from '../dev/dev-mode.js'

/** Spelled again, not imported: `content-root.ts` lives under `src/loader/`,
 * which this directory's README forbids depending on -- a shown page is
 * another site's document, never a pinned bundle. */
const PARTITION_HEADER = 'x-orivon-partition'

export interface EmbedHost {
  /** The app origin that shows guest `webContentsId`, or undefined for anything that is not a live guest. */
  ownerOf(webContentsId: number): string | undefined
}

/** The app origin of the tab a `<webview>` is attaching inside, from the tab's own top frame, never from anything the page sent. */
function embedderOrigin (embedder: WebContents): string | null {
  return originFromUrl(embedder.mainFrame.url)
}

/**
 * The app origin behind an embed partition's session, recorded once in
 * `partitionReady` when the session is first configured. `did-attach-webview`
 * reads it back from the attached guest's OWN `webContents.session` -- never
 * from the embedder's top frame at that later instant, which may have
 * navigated since `will-attach-webview` admitted it -- so a guest is
 * attributed to the app whose grant hardened the partition it actually ended
 * up in, order-independent of every other attach in flight on the same or
 * another tab. See README.md's Design notes for why this holds.
 */
const embedSessionOrigins = new WeakMap<Session, string>()

/**
 * `embedSession`'s own resolver, wrapped to `guestRequestAllowed`'s
 * `resolve` shape -- the whole point of A286's check. Resolving through
 * THIS SPECIFIC session, not `net.resolveHost`/`dns`, is what shares
 * Chromium's host cache with the load `onBeforeRequest` is about to admit
 * or refuse: the same name, asked again moments later to actually connect,
 * answers from that same cache rather than re-querying DNS a second time.
 */
function resolveViaSession (embedSession: Session): (host: string) => Promise<readonly string[]> {
  return async (host) => {
    const resolved = await embedSession.resolveHost(host)
    return resolved.endpoints.map((endpoint) => endpoint.address)
  }
}

/** Tells the app showing guest `guestId` of a window its page asked for or a download it started. */
interface AppNotifier {
  popup: (guestId: number, detail: EmbedPopup) => void
  download: (guestId: number, detail: EmbedDownload) => void
}

/**
 * Wires one embed partition's session, once per process: every download
 * cancelled (the app is told, and no byte is kept), and every document
 * request judged against the app's LIVE grant, read fresh per request so a
 * revoke or a narrowed re-consent reaches the next load. The permission
 * gate already covers this session through its own `session-created`
 * listener.
 */
function configureEmbedSession (embedSession: Session, appOrigin: string, broker: Broker, notify: AppNotifier): void {
  embedSession.on('will-download', (event, item, guest) => {
    // The item is gone from the next tick once cancelled: read it first.
    const detail = downloadDetail({ urlChain: item.getURLChain(), filename: item.getFilename(), mimeType: item.getMimeType(), totalBytes: item.getTotalBytes() })
    event.preventDefault()
    notify.download(guest.id, detail)
  })
  const resolve = resolveViaSession(embedSession)
  embedSession.webRequest.onBeforeRequest((details, callback) => {
    guestRequestAllowed(
      details.url,
      details.resourceType,
      broker.embed.originsSync(appOrigin),
      resolve,
      (port) => broker.embed.holdsListenerSync(appOrigin, port)
    )
      // A callback Electron waits on is called exactly once: a rejection
      // refuses, the way every refusal here fails closed.
      .then((allowed) => !allowed, () => true)
      .then((cancel) => { callback({ cancel }) })
  })
  // A shown page reaches the verifier (a `.eth` name, an `ipfs://` address)
  // the same ordinary way any tab does -- unlike an installed app's own
  // partition, nothing here intercepts `https` with a `protocol.handle`,
  // so no redirect-status quirk rules this out (main/verifier/README.md).
  // Stamped with the SAME rule `installPartitionStamp` applies to the
  // default session (main/verifier/verifier-subsystem.ts): whatever a page
  // set on its own request is stripped, then replaced with its top-level
  // page's own origin, never trusted from the request itself.
  const routedUrls = BUILTIN_ADDRESSES.routedSuffixes().map((suffix) => `https://*.${suffix}/*`)
  embedSession.webRequest.onBeforeSendHeaders({ urls: routedUrls }, (details, callback) => {
    let frame: WebFrameMain | null | undefined
    try {
      frame = details.frame
    } catch {
      frame = undefined
    }
    const partition = requestPartition({ url: details.url, resourceType: details.resourceType, topUrl: frame?.top?.url })
    callback({ requestHeaders: withPartition(details.requestHeaders, PARTITION_HEADER, partition) })
  })
}

/** Installs the host: `will-attach-webview` and `did-attach-webview` on every WebContents from now on. */
export function installEmbedHost (broker: Broker, preloadPath = join(import.meta.dirname, '../preload/embed.js')): EmbedHost {
  const owners = new Map<number, string>()
  /** Guest id -> the page that holds its `<webview>`, where a notice for the guest is sent. */
  const embedders = new Map<number, WebContents>()
  const configured = new Set<string>()

  function sendToApp (guestId: number, name: 'orivon-popup' | 'orivon-download', detail: EmbedPopup | EmbedDownload): void {
    const embedder = embedders.get(guestId)
    if (embedder === undefined || embedder.isDestroyed()) return
    try {
      embedder.mainFrame.send(EMBED_EVENT_CHANNEL, guestId, name, detail)
    } catch {
      // The page's main frame went away between the check and the send: nobody is left to tell.
    }
  }
  const notify: AppNotifier = {
    popup: (guestId, detail) => { sendToApp(guestId, 'orivon-popup', detail) },
    download: (guestId, detail) => { sendToApp(guestId, 'orivon-download', detail) }
  }

  function partitionReady (appOrigin: string): string {
    const partition = embedPartitionFor(appOrigin)
    if (!configured.has(partition)) {
      configured.add(partition)
      const embedSession = electronSession.fromPartition(partition)
      embedSessionOrigins.set(embedSession, appOrigin)
      configureEmbedSession(embedSession, appOrigin, broker, notify)
    }
    return partition
  }

  function adoptGuest (appOrigin: string, guest: WebContents, embedder: WebContents): void {
    let registered: { readonly release: () => void }
    try {
      registered = broker.embed.attach(appOrigin, () => { if (!guest.isDestroyed()) guest.close() })
    } catch (error) {
      console.error(`[orivon][embed ${appOrigin}] a page it tried to show was refused:`, error)
      if (!guest.isDestroyed()) guest.close()
      return
    }
    owners.set(guest.id, appOrigin)
    embedders.set(guest.id, embedder)
    // A shown page opens no windows: what it asked for reaches the app as an
    // event on the element, and the app decides.
    guest.setWindowOpenHandler((details) => {
      notify.popup(guest.id, popupDetail(details))
      return { action: 'deny' }
    })
    guest.once('destroyed', () => {
      owners.delete(guest.id)
      embedders.delete(guest.id)
      registered.release()
    })
  }

  app.on('web-contents-created', (_event, contents) => {
    // Denies from the moment a guest exists: `disablePopups` is off (embed-guard.ts), so a
    // window asked for before `did-attach-webview` would otherwise open under Electron's default.
    if (contents.getType() === 'webview') contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-attach-webview', (event, webPreferences, params) => {
      const appOrigin = embedderOrigin(contents)
      if (appOrigin === null || broker.embed.originsSync(appOrigin) === undefined) {
        event.preventDefault()
        return
      }
      hardenGuest(webPreferences, params, { preloadPath, partition: partitionReady(appOrigin), devTools: devModeEnabled() })
    })
    contents.on('did-attach-webview', (_attachEvent, guest) => {
      const appOrigin = embedSessionOrigins.get(guest.session)
      if (appOrigin === undefined) {
        if (!guest.isDestroyed()) guest.close()
        return
      }
      adoptGuest(appOrigin, guest, contents)
    })
  })

  return { ownerOf: (webContentsId) => owners.get(webContentsId) }
}
