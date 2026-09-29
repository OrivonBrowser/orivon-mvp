// An origin granted without being installed gets the same
// Content-Security-Policy on its documents that an installed app's
// responses carry, built by the same builder from the same live grants --
// ONE handler on the default session's webRequest owner
// (../sessions/web-request-owner.ts), covering every such origin at once,
// installed once at startup rather than once per grant. See README.md's
// Design notes.
//
// Such an origin is served by its own server, never through protocol.handle,
// so onHeadersReceived does fire for its documents (A110 is about
// protocol.handle responses only) -- and a cache-served origin is excluded
// below even if it also holds a grant: ITS CSP is set inside the
// protocol.handle response instead, which this handler never sees (A110
// again -- onHeadersReceived does not fire for that response at all).

import type { OnHeadersReceivedListenerDetails, WebRequestFilter } from 'electron'
import type { Broker } from '../../broker/broker-contracts.js'
import { isOriginServedFromCacheSync, liveCspHeaderFor } from '../../loader/electron/serve.js'
import { ISOLATION_HEADERS } from '../../loader/serve/csp.js'
import type { HeadersReceivedHandler } from '../sessions/web-request-owner.js'

/**
 * `defaultSessionGrantedOriginCsp`'s own `WebRequestFilter`: `<all_urls>`
 * because a granted origin is not known in advance (a grant can be given to
 * any origin at any time, per ADR-0044), restricted to `mainFrame`/
 * `subFrame`/`object` because `documentOriginOf` below already discards
 * every other resource type -- so this filter costs nothing beyond what the
 * handler already throws away, while sparing every subresource response
 * (script, image, stylesheet, xhr, ...) the round trip into this process at
 * all. `object` is a document too: Electron reports a same-origin
 * `<object>`/`<embed>` document's own response with that resource type
 * (measured, Electron 44), and without it here that document is served with
 * the app's own CSP, never this one -- `csp.ts`'s `object-src 'none'` is the
 * other lock on the same route.
 */
export const GRANTED_ORIGIN_CSP_FILTER: WebRequestFilter = { urls: ['<all_urls>'], types: ['mainFrame', 'subFrame', 'object'] }

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

/**
 * The document origin `details` is a response for, or null for anything
 * that is not a document -- a script/image/xhr/etc response must never be
 * treated as if it were the page itself. `object` counts as a document:
 * a same-origin `<object>`/`<embed>` navigates its `data`/`src` the same
 * way a `<frame>` does, and Electron reports its response that way
 * (measured, Electron 44).
 */
export function documentOriginOf (details: OnHeadersReceivedListenerDetails): string | null {
  if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame' && details.resourceType !== 'object') return null
  try {
    return new URL(details.url).origin
  } catch {
    return null
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
 * The default session's one `onHeadersReceived` handler for every origin
 * granted without being installed. Reads the live grant, and the cache
 * registry, fresh per response -- a grant, a revoke, a manifest change or an
 * origin starting/stopping being cache-served all reach the very next
 * document load, with nothing to re-register. Only for a document: a worker
 * script the server sends without the policy is that server's own to fix,
 * same as the installed path's own handler.
 *
 * A handler that throws (a broker read failing, for instance) is caught by
 * the owner itself (web-request-owner.ts), which passes the response
 * through unmodified rather than hanging it -- this function does not need
 * its own try/catch to get that behaviour.
 */
export function defaultSessionGrantedOriginCsp (broker: Broker): HeadersReceivedHandler {
  return async (details, current) => {
    const origin = documentOriginOf(details)
    if (origin === null || isOriginServedFromCacheSync(origin) || broker.app.hasGrantsSync(origin) !== true) return current
    const [csp, isolated] = await Promise.all([
      liveCspHeaderFor(broker, origin),
      broker.app.manifest(origin).then((manifest) => manifest.crossOriginIsolated === true).catch(() => false)
    ])
    const withCsp = withAppendedCsp(current.responseHeaders, csp)
    return { ...current, responseHeaders: isolated ? withIsolationHeaders(withCsp) : withCsp }
  }
}
