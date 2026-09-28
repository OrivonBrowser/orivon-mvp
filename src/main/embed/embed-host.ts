// ADR-0039's Electron half: turns a `<webview>` attaching inside an app tab
// into a page the app is allowed to show, and keeps it that way. Every
// decision is ./embed-guard.ts's; this file is what Electron calls.
//
// Attached through `app.on('web-contents-created')` rather than in
// tab-view.ts's per-view wiring, for the reason permission-gate.ts gives
// for sessions: the event reaches every WebContents this process ever
// makes, so a popup adopted as a tab, or a view a later stream builds, is
// covered without remembering to wire it.

import { app, session as electronSession } from 'electron'
import type { Session, WebContents } from 'electron'
import { join } from 'node:path'
import type { Broker } from '../../broker/broker-contracts.js'
import { originFromUrl } from '../../broker/policy/origin.js'
import { embedPartitionFor, guestRequestAllowedAsync, hardenGuest } from './embed-guard.js'
import { devModeEnabled } from '../dev/dev-mode.js'

export interface EmbedHost {
  /** The app origin that shows guest `webContentsId`, or undefined for anything that is not a live guest. */
  ownerOf(webContentsId: number): string | undefined
}

/** The app origin of the tab a `<webview>` is attaching inside, from the tab's own top frame, never from anything the page sent. */
function embedderOrigin (embedder: WebContents): string | null {
  return originFromUrl(embedder.mainFrame.url)
}

/**
 * The origin `will-attach-webview` admitted, carried to that SAME attach's
 * `did-attach-webview` -- which gets no origin of its own, only the new
 * guest `WebContents`, so it cannot re-derive one (R7-07). Re-reading
 * `embedderOrigin(contents)` a second time there would trust whatever the
 * embedder's top frame shows AT THAT LATER INSTANT: if it navigated in
 * between, the guest would be hardened (partition, preload) under one
 * origin's grant and then attributed to and governed by another. Queued
 * per embedder, FIFO, because one tab may attach several `<webview>`s
 * whose will/did pairs are not guaranteed not to interleave; each pair
 * still resolves in the order it was admitted.
 */
const pendingEmbedderOrigins = new WeakMap<WebContents, string[]>()

function queueEmbedderOrigin (embedder: WebContents, origin: string): void {
  const queue = pendingEmbedderOrigins.get(embedder)
  if (queue === undefined) pendingEmbedderOrigins.set(embedder, [origin])
  else queue.push(origin)
}

/** The next queued origin for `embedder`, or undefined if none is pending (no matching `will-attach-webview` admitted one). */
function dequeueEmbedderOrigin (embedder: WebContents): string | undefined {
  return pendingEmbedderOrigins.get(embedder)?.shift()
}

/**
 * `embedSession`'s own resolver, wrapped to `guestRequestAllowedAsync`'s
 * `resolve` shape -- the C-7/A286 fix's whole point. Resolving through
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

/**
 * Wires one embed partition's session, once per process: no downloads, and
 * every document request judged against the app's LIVE grant, read fresh
 * per request so a revoke or a narrowed re-consent reaches the next load.
 * The permission gate already covers this session through its own
 * `session-created` listener.
 */
function configureEmbedSession (embedSession: Session, appOrigin: string, broker: Broker): void {
  embedSession.on('will-download', (event) => { event.preventDefault() })
  const resolve = resolveViaSession(embedSession)
  embedSession.webRequest.onBeforeRequest((details, callback) => {
    guestRequestAllowedAsync(details.url, details.resourceType, broker.embed.originsSync(appOrigin), resolve)
      .then((allowed) => { callback({ cancel: !allowed }) })
      // guestRequestAllowedAsync never itself rejects (it catches `resolve`
      // failing), but a callback Electron waits on must never go uncalled
      // regardless -- fail closed the same way every refusal here does.
      .catch(() => { callback({ cancel: true }) })
  })
}

/** Installs the host: `will-attach-webview` and `did-attach-webview` on every WebContents from now on. */
export function installEmbedHost (broker: Broker, preloadPath = join(import.meta.dirname, '../preload/embed.js')): EmbedHost {
  const owners = new Map<number, string>()
  const configured = new Set<string>()

  function partitionReady (appOrigin: string): string {
    const partition = embedPartitionFor(appOrigin)
    if (!configured.has(partition)) {
      configured.add(partition)
      configureEmbedSession(electronSession.fromPartition(partition), appOrigin, broker)
    }
    return partition
  }

  function adoptGuest (appOrigin: string, guest: WebContents): void {
    let registered: { readonly release: () => void }
    try {
      registered = broker.embed.attach(appOrigin, () => { if (!guest.isDestroyed()) guest.close() })
    } catch (error) {
      console.error(`[orivon][embed ${appOrigin}] a page it tried to show was refused:`, error)
      if (!guest.isDestroyed()) guest.close()
      return
    }
    owners.set(guest.id, appOrigin)
    // A shown page opens no windows: a popup it asks for goes nowhere, and
    // the app hears nothing (ADR-0039's stated limit).
    guest.setWindowOpenHandler(() => ({ action: 'deny' }))
    guest.once('destroyed', () => {
      owners.delete(guest.id)
      registered.release()
    })
  }

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event, webPreferences, params) => {
      const appOrigin = embedderOrigin(contents)
      if (appOrigin === null || broker.embed.originsSync(appOrigin) === undefined) {
        event.preventDefault()
        return
      }
      queueEmbedderOrigin(contents, appOrigin)
      hardenGuest(webPreferences, params, { preloadPath, partition: partitionReady(appOrigin), devTools: devModeEnabled() })
    })
    contents.on('did-attach-webview', (_attachEvent, guest) => {
      const appOrigin = dequeueEmbedderOrigin(contents)
      if (appOrigin === undefined) {
        if (!guest.isDestroyed()) guest.close()
        return
      }
      adoptGuest(appOrigin, guest)
    })
  })

  return { ownerOf: (webContentsId) => owners.get(webContentsId) }
}
