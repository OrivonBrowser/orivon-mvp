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
 * The bundle's own code is pinned and hash-verified, `'unsafe-inline'`
 * already grants the script power `'unsafe-eval'` adds, and the broker, not
 * this header, is the security boundary.
 */
const SCRIPT_SOURCES = ["'self'", "'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'"] as const

function directive (name: string, sources: readonly string[]): string {
  return `${name} ${sources.join(' ')}`
}

/**
 * The header value for one response. `connectPatterns` is the live
 * `tcp.connect` grant, `securePatterns` the live `https.connect` grant;
 * both are read fresh per request by the caller.
 *
 * `form-action` is deliberately unset: it has no fallback to `default-src`,
 * and restricting it would also refuse the redirects a form-post sign-in
 * flow follows.
 */
export function cspHeaderValue (connectPatterns: readonly Pattern[], securePatterns: readonly Pattern[]): string {
  const reach = reachSourcesFor(securePatterns).sources
  const connectTokens = connectSrcFor(connectPatterns).sources.slice(1)
  const withLocal = ["'self'", ...LOCAL_SCHEMES]
  return [
    "default-src 'self'",
    directive('script-src', SCRIPT_SOURCES),
    "style-src 'self' 'unsafe-inline'",
    directive('connect-src', [...withLocal, ...connectTokens, ...reach]),
    directive('img-src', [...withLocal, ...reach]),
    directive('font-src', [...withLocal, ...reach]),
    directive('media-src', [...withLocal, ...reach]),
    "worker-src 'self' blob:",
    directive('frame-src', withLocal)
  ].join('; ')
}
