// The Electron half of ADR-0069. The Content-Security-Policy of a page that holds a `tcp.listen`
// grant admits `http://localhost:*` and `http://127.0.0.1:*` for `<img>`, `<audio>` and `<video>`,
// because CSP cannot name a port the page has not been given yet. This gate is what narrows that to
// the ports the page's own listeners hold: a loopback image or media request from such a page to any
// other port is cancelled before it connects. The decision is pure and lives in
// ../../broker/policy/own-listener-media.ts, which also says why T12 reads the same afterwards.
//
// Installed on the default session, where a granted origin's page runs, and on each session an app is
// served from (a cache-served origin's own partition). Both register through the web-request owner,
// never a raw `session.webRequest.onBeforeRequest`, which would replace a sibling's listener.

import { session, webContents } from 'electron'
import type { OnBeforeRequestListenerDetails, Session, WebFrameMain, WebRequestFilter } from 'electron'
import type { Broker } from '../../broker/broker-contracts.js'
import { ownListenerMediaVerdict, requestingDocumentOf } from '../../broker/policy/own-listener-media.js'
import { forEachAppSession, holdsListenGrant } from '../../loader/electron/serve.js'
import type { Subsystem } from '../registry.js'
import { webRequestOwnerFor } from './web-request-owner.js'

/**
 * Only the two resource types the widened CSP admits, and only the loopback spellings a listener
 * answers on: an ordinary page's traffic never reaches this process. Another loopback address
 * (`127.0.0.2`) needs no entry, because the page's policy already refuses it.
 */
export const OWN_LISTENER_MEDIA_FILTER: WebRequestFilter = {
  urls: ['http://localhost/*', 'http://127.0.0.1/*', 'http://[::1]/*', 'https://localhost/*', 'https://127.0.0.1/*', 'https://[::1]/*'],
  types: ['image', 'media']
}

/**
 * The frame a request belongs to, or undefined: the `frame` getter throws once the frame is gone. A
 * request the browser itself makes for a page (its tab icon) has no frame but names the page's
 * contents, and belongs to that page's main frame.
 */
function frameOf (details: OnBeforeRequestListenerDetails): WebFrameMain | null | undefined {
  try {
    if (details.frame !== null && details.frame !== undefined) return details.frame
    return details.webContentsId === undefined ? undefined : webContents.fromId(details.webContentsId)?.mainFrame
  } catch {
    return undefined
  }
}

/** Registers the gate on `target`: cancels what `ownListenerMediaVerdict` cancels. */
export function installOwnListenerMediaGate (target: Session, broker: () => Broker | undefined): void {
  webRequestOwnerFor(target).onBeforeRequest(0, OWN_LISTENER_MEDIA_FILTER, () => true, async (details, current) => {
    const document = requestingDocumentOf(frameOf(details))
    const live = broker()
    let holdsGrant = false
    let holdsPort: (port: number) => boolean = () => false
    if (document.kind === 'web' && live !== undefined) {
      holdsGrant = await holdsListenGrant(live, document.origin)
      holdsPort = (port) => live.embed.holdsListenerSync(document.origin, port)
    }
    // Before the broker exists no page holds a grant, and no widened policy has been sent to one.
    const verdict = ownListenerMediaVerdict({ document, url: details.url, holdsListenGrant: holdsGrant, holdsPort })
    return verdict === 'cancel' ? { ...current, cancel: true } : current
  })
}

export const ownListenerMediaGateSubsystem: Subsystem = {
  name: 'own-listener-media-gate',
  // The gate is half of a CSP widening: the widening without it admits every loopback port.
  critical: true,
  afterReady: (ctx) => {
    const broker = (): Broker | undefined => ctx.broker
    installOwnListenerMediaGate(session.defaultSession, broker)
    forEachAppSession((appSession) => { installOwnListenerMediaGate(appSession, broker) })
  }
}
