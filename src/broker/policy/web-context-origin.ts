// ADR-0019's `web.context` origin grammar -- shared by the loader's manifest
// validator (src/loader/manifest/capabilities.ts's readWeb, rich per-reason
// messages) and the broker's own runtime gate (../web-capability.ts's
// openContext, which checks a CALLER-SUPPLIED origin a manifest declaration
// never protects against). One implementation of the rule
// (docs/development/code-guidelines.md Rule 3), the same "reason enum in
// policy/, words in the caller" split ./connect-patterns.ts's own
// declarableConnectHostRejection already uses for tcp.connect/https.connect's
// host grammar.

import { classifyAddress } from './address.js'
import { isLocalhostName } from './origin.js'

export type WebContextOriginRejection =
  | 'unparseable'
  | 'not-https'
  | 'wildcard-host'
  | 'userinfo'
  | 'query-or-fragment'
  | 'path'
  | 'not-canonical'
  | 'address-not-public-unicast'
  | 'localhost-name'

/**
 * Why `origin` is not a valid `web.context` origin, or null if it is.
 *
 * An EXACT `https://host[:port]` origin only: no wildcard, no path beyond
 * `/`, no userinfo, no query or fragment, and `url.origin === origin` so the
 * canonical form is the only accepted spelling (capability-api.ts's
 * `WebCapability.contexts` doc) -- a grant's own patterns compare these
 * strings exactly, so a second spelling of the same origin would silently
 * fail to match the one a person actually consented to. Also refuses an
 * address literal outside public unicast (security-model.md T12) and any
 * `localhost` name (RFC 6761 SS6.3's whole namespace, not just the bare
 * label).
 */
export function webContextOriginRejection (origin: string): WebContextOriginRejection | null {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return 'unparseable'
  }

  if (url.protocol !== 'https:') return 'not-https'
  // `*` is not a forbidden host code point to the URL parser itself (a
  // wildcard host would otherwise sail through the canonical-form check
  // below unchanged), so the "no wildcard" rule needs its own line.
  if (url.hostname.includes('*')) return 'wildcard-host'
  if (url.username !== '' || url.password !== '') return 'userinfo'
  if (url.search !== '' || url.hash !== '') return 'query-or-fragment'
  if (url.pathname !== '/') return 'path'
  if (url.origin !== origin) return 'not-canonical'

  const cls = classifyAddress(url.hostname)
  if (cls !== 'unparseable' && cls !== 'public') return 'address-not-public-unicast'
  if (isLocalhostName(url.hostname)) return 'localhost-name'

  return null
}

/** `webContextOriginRejection(origin) === null`, for a caller that only needs the boolean gate. */
export function isExactWebContextOrigin (origin: string): boolean {
  return webContextOriginRejection(origin) === null
}
