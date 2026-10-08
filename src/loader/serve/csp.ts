// The Content-Security-Policy every pinned asset is served with -- pure, no
// I/O. Split out of serve.ts (Rule 2), the same seam serve/range.ts and
// serve/content-type.ts use. The grant-derived source lists come from
// ../../broker/policy/connect-src.ts; this file only assembles the header.
// README.md's Design notes ("What the served bundle's CSP admits, and why")
// has the reasoning behind each directive.

import { connectSrcFor, reachSourcesFor } from '../../broker/policy/connect-src.js'
import type { Pattern } from '../../contracts/index.js'

/** A page can only point these at bytes it already holds: neither has any network reach behind it. */
const LOCAL_SCHEMES = ['data:', 'blob:'] as const

/**
 * No `'unsafe-inline'`: a Chrome extension with host
 * access can still write to the page's DOM, and an inline `<script>` it
 * writes there would otherwise run as the app's own code -- closing that
 * route is this directive's whole job, alongside
 * `../../preload/surface/main-world-socket.ts`'s own caller-attribution
 * check on `window.orivon` (that file's own README.md has the fuller
 * picture). `'unsafe-eval'` stays: the bundle's own code is pinned and
 * hash-verified, and an app's own `eval`/`new Function` is not the route
 * being closed here.
 */
const SCRIPT_SOURCES = ["'self'", "'unsafe-eval'", "'wasm-unsafe-eval'"] as const

/**
 * The hosts a listener the app opened answers on. `:*` because CSP cannot name a port the app has
 * not been given yet; the main-process gate (../../main/sessions/own-listener-media-gate.ts) is what
 * narrows these to the ports the app's own listeners hold. No `[::1]`: CSP's host grammar has no
 * source for an IPv6 literal (Chromium drops it with a console warning, measured on Electron 44),
 * and the listener binds IPv4 loopback anyway.
 */
const OWN_LISTENER_SOURCES = ['http://localhost:*', 'http://127.0.0.1:*'] as const

/**
 * What a caller may relax: `inlineScripts` is for a document no extension runs in (a granted local
 * file); `ownListenerMedia` is for an app that holds a `tcp.listen` grant, whose own in-page server
 * its `<video>`, `<audio>` and `<img>` may then load from (ADR-0069).
 */
export interface CspOptions {
  readonly inlineScripts?: boolean
  readonly ownListenerMedia?: boolean
}

/**
 * What a manifest's `crossOriginIsolated: true` asks for: the two headers
 * that make a document cross-origin isolated, so `SharedArrayBuffer` and a
 * shared `WebAssembly.Memory` exist in it. `credentialless` rather than
 * `require-corp`, so a cross-origin subresource the CSP already admits still
 * loads, without credentials, instead of needing a CORP header the app does
 * not control. On every served asset, like the CSP: a worker's own response
 * must carry them too, or the worker is not isolated.
 */
export const ISOLATION_HEADERS = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'credentialless'
} as const

function directive (name: string, sources: readonly string[]): string {
  return `${name} ${sources.join(' ')}`
}

/**
 * The header value for one response. `connectPatterns` is the live
 * `tcp.connect` grant, `securePatterns` the live `https.connect` grant;
 * both are read fresh per request by the caller.
 *
 * `options.inlineScripts` adds `'unsafe-inline'` to `script-src`. The refusal above exists for
 * extension-written DOM, and a granted local file runs in a session that loads no extension.
 *
 * `options.ownListenerMedia` adds the app's own loopback hosts to `img-src` and `media-src` and to
 * nothing else: `fetch` and sockets already go through the broker, and `frame-src` is `web.embed`'s.
 *
 * `form-action` is deliberately unset: it has no fallback to `default-src`,
 * and restricting it would also refuse the redirects a form-post sign-in
 * flow follows.
 */
export function cspHeaderValue (connectPatterns: readonly Pattern[], securePatterns: readonly Pattern[], options: CspOptions = {}): string {
  const reach = reachSourcesFor(securePatterns).sources
  const connectTokens = connectSrcFor(connectPatterns).sources.slice(1)
  const withLocal = ["'self'", ...LOCAL_SCHEMES]
  const ownListener = options.ownListenerMedia === true ? OWN_LISTENER_SOURCES : []
  return [
    "default-src 'self'",
    directive('script-src', options.inlineScripts === true ? [...SCRIPT_SOURCES, "'unsafe-inline'"] : SCRIPT_SOURCES),
    "style-src 'self' 'unsafe-inline'",
    // See README.md's Design notes for why this is 'none' rather than left to default-src.
    "object-src 'none'",
    directive('connect-src', [...withLocal, ...connectTokens, ...reach]),
    directive('img-src', [...withLocal, ...ownListener, ...reach]),
    directive('font-src', [...withLocal, ...reach]),
    directive('media-src', [...withLocal, ...ownListener, ...reach]),
    "worker-src 'self' blob:",
    directive('frame-src', withLocal)
  ].join('; ')
}
