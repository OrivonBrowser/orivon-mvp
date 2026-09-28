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
import { liveCspHeaderFor } from '../../loader/electron/serve.js'
import { ISOLATION_HEADERS } from '../../loader/serve/csp.js'

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

/** `headers` plus the two cross-origin isolation headers, replacing the server's own if it sent any: the manifest asked for isolation, and a weaker server value would silently deny it. */
export function withIsolationHeaders (headers: Record<string, string[]>): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  const replaced = new Set(Object.keys(ISOLATION_HEADERS))
  for (const [name, value] of Object.entries(headers)) {
    if (!replaced.has(name.toLowerCase())) result[name] = value
  }
  for (const [name, value] of Object.entries(ISOLATION_HEADERS)) result[name] = [value]
  return result
}

/**
 * The `onHeadersReceived` listener for one granted origin. `cspFor` is read
 * per response, so a grant or revoke reaches the next document load;
 * `isolatedFor` (the manifest's `crossOriginIsolated`) the same way, so a
 * manifest change reaches the next load too. Unlike the installed path,
 * which sets the isolation headers on every served asset, a listener sees
 * only documents here: a worker script the server sends without them is
 * that server's own to fix.
 */
export function grantedOriginCspListener (origin: string, cspFor: () => Promise<string>, isolatedFor: () => Promise<boolean> = async () => false): HeadersListener {
  return (details, callback) => {
    if (!isDocumentFrom(details, origin)) {
      callback({})
      return
    }
    // A manifest that cannot be read means "not isolated", never a document
    // without its policy.
    Promise.all([cspFor(), isolatedFor().catch(() => false)]).then(
      ([csp, isolated]) => {
        const withCsp = withAppendedCsp(details.responseHeaders, csp)
        callback({ responseHeaders: isolated ? withIsolationHeaders(withCsp) : withCsp })
      },
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
    grantedOriginCspListener(
      origin,
      async () => await liveCspHeaderFor(broker, origin),
      async () => (await broker.app.manifest(origin)).crossOriginIsolated === true
    )
  )
}
