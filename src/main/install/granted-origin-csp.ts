// An origin granted without being installed gets the same
// Content-Security-Policy on its documents that an installed app's
// responses carry, built by the same builder from the same live grants --
// ONE handler on the default session's webRequest owner
// (../sessions/web-request-owner.ts), covering every such origin at once,
// installed once at startup rather than once per grant. See README.md's
// Design notes.
//
// This handler covers every granted origin's document that reaches the
// default session, including one that is also cache-served: a navigation
// into a cache-served origin commits its network-delivered document here,
// in the default session, before the tab's partition swap moves later
// requests to protocol.handle (A296) -- that document needs this policy
// exactly as much as one that is never cache-served. The pinned copy's own
// response, served through protocol.handle, never reaches onHeadersReceived
// at all (A110), so it carries its own policy from csp.ts regardless.

import type { OnHeadersReceivedListenerDetails, WebRequestFilter } from 'electron'
import type { Broker } from '../../broker/broker-contracts.js'
import { originFromUrl } from '../../broker/policy/origin.js'
import { liveCspHeaderFor } from '../../loader/electron/serve.js'
import { ISOLATION_HEADERS } from '../../loader/serve/csp.js'
import type { HeadersReceivedHandler } from '../sessions/web-request-owner.js'

/**
 * The responses that ARE a document. `object` counts: a same-origin
 * `<object>`/`<embed>` navigates its `data`/`src` the same way a `<frame>`
 * does, and Electron reports its response that way (measured, Electron 44).
 */
const DOCUMENT_TYPES: ReadonlySet<string> = new Set(['mainFrame', 'subFrame', 'object'])

/**
 * A dedicated or shared worker's top-level script response -- Electron's
 * `OnHeadersReceivedListenerDetailsResourceType` has no dedicated "worker"
 * member at all (its full union is `mainFrame`/`subFrame`/`stylesheet`/
 * `script`/`image`/`font`/`object`/`xhr`/`ping`/`cspReport`/`media`/
 * `webSocket`/`other`), and a worker's own script fetch is classified as
 * `'script'`, or `'other'` on some platform/version combinations -- both
 * handled here rather than assuming one (the filter below can select only
 * `script`; see its own doc). The installed path covers every served asset
 * regardless of type; this handler sees only network responses, so it
 * names exactly the ones a document's CSP still has to reach.
 *
 * A CSP header on any OTHER response of these types (a classic script, not
 * a worker) is inert -- Chromium enforces `Content-Security-Policy` only
 * from a document or a worker global scope's own response -- so covering
 * `script`/`other` too broadly costs one extra grant read for a granted
 * origin's script that turns out not to be a worker.
 */
const WORKER_SCRIPT_TYPES: ReadonlySet<string> = new Set(['script', 'other'])

/**
 * `defaultSessionGrantedOriginCsp`'s own `WebRequestFilter`: `<all_urls>`
 * because a granted origin is not known in advance (a grant can be given to
 * any origin at any time, per ADR-0044), restricted to the document types
 * and `script` because the handler below discards every other resource
 * type but `other` -- so this filter spares every image, stylesheet, xhr,
 * ... response the round trip into this process at all. Without `object` a same-origin
 * `<object>`/`<embed>` document is served with the app's own CSP, never
 * this one -- `csp.ts`'s `object-src 'none'` is the other lock on the same
 * route.
 *
 * `'other'` is not here because Electron's filter cannot name it (its
 * `types` union stops at `webSocket`): a worker script reported as `'other'`
 * reaches the handler only while some other handler on this session leaves
 * the shared listener unfiltered by type. `script` is the case this filter
 * relies on, provisionally: Chromium maps the worker request destinations
 * to its `script` type, and a fixture worker logging its own `resourceType`
 * under Electron 44 would settle it. Dropping `types` altogether to catch
 * `'other'` would put every subresource of every site through this process.
 */
export const GRANTED_ORIGIN_CSP_FILTER: WebRequestFilter = { urls: ['<all_urls>'], types: ['mainFrame', 'subFrame', 'object', 'script'] }

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
 * treated as if it were the page itself. The origin goes through the same
 * canonicalisation as everywhere else a document is matched against its
 * grants (`originFromUrl`, `partitionFor`), never a bare
 * `new URL(...).origin`: `http://localhost.` (a trailing dot -- the same
 * host under DNS's own rules) and `http://localhost` parse to two DIFFERENT
 * `URL.origin` strings but the SAME `originFromUrl`, and the broker and
 * `tab-view.ts`'s `partitionForTarget` both key the dotted spelling to the
 * same origin's grants.
 */
export function documentOriginOf (details: OnHeadersReceivedListenerDetails): string | null {
  return DOCUMENT_TYPES.has(details.resourceType) ? originFromUrl(details.url) : null
}

/** `documentOriginOf`'s counterpart for a response that may be a worker's own script (`WORKER_SCRIPT_TYPES`), canonicalised the same way. */
export function workerScriptOriginOf (details: OnHeadersReceivedListenerDetails): string | null {
  return WORKER_SCRIPT_TYPES.has(details.resourceType) ? originFromUrl(details.url) : null
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
 * The default session's one `onHeadersReceived` handler for every granted
 * origin's document, and worker script, that reaches that session, whether
 * or not that origin is also cache-served. Reads the live grant fresh per
 * response -- a grant, a revoke or a manifest change all reach the very
 * next load, with nothing to re-register.
 *
 * The two ISOLATION headers stay on documents only, unlike the installed
 * path (which sets them on every served asset): unlike a CSP, COOP/COEP on
 * the WRONG response can actively break an otherwise working page (COEP on
 * a same-origin sub-resource the page does not itself mark
 * `crossOriginEmbedderPolicy`-aware fails to load it). A worker script the
 * server sends without them is that server's own to fix.
 *
 * A handler that throws (a broker read failing, for instance) is caught by
 * the owner itself (web-request-owner.ts), which passes the response
 * through unmodified rather than hanging it -- this function does not need
 * its own try/catch to get that behaviour.
 */
export function defaultSessionGrantedOriginCsp (broker: Broker): HeadersReceivedHandler {
  return async (details, current) => {
    const documentOrigin = documentOriginOf(details)
    const origin = documentOrigin ?? workerScriptOriginOf(details)
    if (origin === null || broker.app.hasGrantsSync(origin) !== true) return current
    // A manifest that cannot be read means "not isolated", never a document
    // without its policy.
    const [csp, isolated] = await Promise.all([
      liveCspHeaderFor(broker, origin, { ownListenerMedia: true }),
      documentOrigin !== null ? broker.app.manifest(origin).then((manifest) => manifest.crossOriginIsolated === true).catch(() => false) : Promise.resolve(false)
    ])
    const withCsp = withAppendedCsp(current.responseHeaders, csp)
    return { ...current, responseHeaders: isolated ? withIsolationHeaders(withCsp) : withCsp }
  }
}
