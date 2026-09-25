// An origin granted without installing (./grant-without-install.ts) gets the
// same Content-Security-Policy on its documents that an installed app's
// responses carry, built by the same builder from the same live grants. See
// README.md's Design notes.
//
// Such an origin is served by its own server, never through protocol.handle,
// so session.webRequest.onHeadersReceived does fire for it (A110 is about
// protocol.handle responses only).

import { session } from 'electron'
import type { HeadersReceivedResponse, OnHeadersReceivedListenerDetails } from 'electron'
import type { Broker } from '../../broker/broker-contracts.js'
import { partitionFor } from '../../broker/grants/origin-hash.js'
import { liveCspHeaderFor } from '../../loader/electron-serve.js'

type HeadersListener = (details: OnHeadersReceivedListenerDetails, callback: (response: HeadersReceivedResponse) => void) => void

/**
 * `headers` plus `csp` as one more Content-Security-Policy value. The
 * server's own policy stays: the browser enforces every policy it is sent,
 * so the result is their intersection, never a relaxation of either.
 */
export function withAppendedCsp (headers: Record<string, string[]> | undefined, csp: string): Record<string, string[]> {
  const result: Record<string, string[]> = { ...headers }
  const existing = Object.keys(result).find((name) => name.toLowerCase() === 'content-security-policy')
  const name = existing ?? 'Content-Security-Policy'
  result[name] = [...(result[name] ?? []), csp]
  return result
}

function isDocumentFrom (details: OnHeadersReceivedListenerDetails, origin: string): boolean {
  if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') return false
  try {
    return new URL(details.url).origin === origin
  } catch {
    return false
  }
}

/** The `onHeadersReceived` listener for one granted origin. `cspFor` is read per response, so a grant or revoke reaches the next document load. */
export function grantedOriginCspListener (origin: string, cspFor: () => Promise<string>): HeadersListener {
  return (details, callback) => {
    if (!isDocumentFrom(details, origin)) {
      callback({})
      return
    }
    cspFor().then(
      (csp) => { callback({ responseHeaders: withAppendedCsp(details.responseHeaders, csp) }) },
      // The callback must always run, or the response hangs.
      () => { callback({}) }
    )
  }
}

/**
 * Installs the listener on `origin`'s app partition, the session its app tab
 * runs in once granted. Electron keeps one `onHeadersReceived` listener per
 * session, so calling this again for the same origin replaces it; nothing
 * else in src/ listens on an app partition's `webRequest`.
 */
export function installGrantedOriginCsp (broker: Broker, origin: string): void {
  session.fromPartition(partitionFor(origin)).webRequest.onHeadersReceived(
    grantedOriginCspListener(origin, async () => await liveCspHeaderFor(broker, origin))
  )
}
