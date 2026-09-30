// ADR-0039's `web.embed` pattern grammar and its document gate (with the
// local pattern ADR-0047 adds beside an exact origin and "*") -- shared by
// the loader's manifest validator (src/loader/manifest/capabilities.ts's
// readEmbed, rich per-reason messages) and the shell's own runtime gate
// (src/main/embed/, which decides whether a shown page may load a document
// at a URL). One implementation of the rule (code-guidelines.md Rule 3),
// the same "reason enum in policy/, words in the caller" split
// ./web-context-origin.ts already uses for `web.context`.

import { classifyAddress } from './address.js'
import { isLocalhostName } from './origin.js'
import type { Pattern } from '../../contracts/index.js'

/** The one pattern that is not an origin: any site on the web. */
export const ANY_SITE: Pattern = '*'

const DNS_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const LOCAL_PATTERN = new RegExp(`^http://\\*\\.((?:${DNS_LABEL}\\.)*)localhost:([1-9][0-9]{3,4})$`)
const SINGLE_LABEL = new RegExp(`^${DNS_LABEL}$`)
const MIN_LOCAL_PORT = 1024
const MAX_LOCAL_PORT = 65535

/** A parsed local pattern: the port, and the host suffix (`.localhost` or `.<name>.localhost`) that follows the one label `*` stands for. */
export interface LocalPattern {
  readonly port: number
  readonly suffix: string
}

/**
 * `http://*.localhost:<port>` or `http://*.<name>.localhost:<port>`, in its
 * canonical spelling only, or null. `*` is the leftmost label and the only
 * one; each `<name>` label is 1 to 63 characters of lowercase letters,
 * digits and hyphens, with no hyphen at either end (a DNS label); the port
 * is written out, without leading zeros, from 1024 to 65535.
 */
export function parseLocalPattern (pattern: string): LocalPattern | null {
  const match = LOCAL_PATTERN.exec(pattern)
  if (match === null) return null
  const port = Number(match[2])
  if (port < MIN_LOCAL_PORT || port > MAX_LOCAL_PORT) return null
  return { port, suffix: `.${match[1] ?? ''}localhost` }
}

export type EmbedOriginRejection =
  | 'unparseable'
  | 'not-http'
  | 'wildcard-host'
  | 'userinfo'
  | 'query-or-fragment'
  | 'path'
  | 'not-canonical'

/**
 * Why `pattern` is not a valid `web.embed` pattern, or null if it is.
 *
 * `"*"` and a local pattern (`parseLocalPattern`) pass. Anything else must be an EXACT `http://host[:port]` or
 * `https://host[:port]` origin: no wildcard host, no path beyond `/`, no
 * userinfo, no query or fragment, and `url.origin === pattern` so the
 * canonical form is the only accepted spelling (a grant's patterns compare
 * these strings exactly). Unlike `web.context`, an address literal outside
 * public unicast or a `localhost` name IS accepted here when named exactly:
 * the person granting it sees that address, the same rule `tcp.connect`
 * applies to a literal pattern. Only the wildcard stops short of them,
 * in `embedDocumentAllowed` below.
 */
export function embedOriginRejection (pattern: string): EmbedOriginRejection | null {
  if (pattern === ANY_SITE || parseLocalPattern(pattern) !== null) return null
  let url: URL
  try {
    url = new URL(pattern)
  } catch {
    return 'unparseable'
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'not-http'
  if (url.hostname.includes('*')) return 'wildcard-host'
  if (url.username !== '' || url.password !== '') return 'userinfo'
  if (url.search !== '' || url.hash !== '') return 'query-or-fragment'
  if (url.pathname !== '/') return 'path'
  if (url.origin !== pattern) return 'not-canonical'
  return null
}

/** A hostname, or an address literal in public unicast: what `"*"` reaches (security-model.md T12). */
function reachableByWildcard (hostname: string): boolean {
  if (isLocalhostName(hostname)) return false
  const cls = classifyAddress(hostname)
  return cls === 'public' || cls === 'unparseable'
}

/**
 * HOW a document load at `url` is admitted under `patterns` -- never just
 * whether. `'local'`: a local pattern matched, a `http` host of one DNS label
 * under the pattern's suffix on its port; that says nothing about who holds
 * the port, which the caller checks (ADR-0047), and nothing is resolved for
 * it. `'exact'`: an exact-origin pattern matched (or the URL is
 * `about:`/`data:`, which reach no site at all, or `blob:`, judged by the
 * origin that minted it); ADR-0039 lets a named origin be private, so
 * nothing about it is ever resolved. `'wildcard'`: only `"*"` admitted it,
 * carrying the hostname that passed `reachableByWildcard`'s pure gate --
 * the caller (`../../main/embed/embed-guard.ts`) decides from there whether
 * that hostname still needs its connected address checked (an address
 * literal does not; a name does, A286). `'refused'`: neither, or the URL
 * does not parse. An exact match anywhere in `patterns` wins over a
 * wildcard match, whichever appears first -- `embedDocumentAllowed` below
 * depends only on `!== 'refused'`, so this is a refinement, not a new rule.
 */
export type EmbedAdmission =
  | { readonly kind: 'exact' }
  | { readonly kind: 'wildcard', readonly hostname: string }
  | { readonly kind: 'refused' }

const EXACT: EmbedAdmission = { kind: 'exact' }
const REFUSED: EmbedAdmission = { kind: 'refused' }

export function embedAdmissionKind (url: string, patterns: readonly Pattern[]): EmbedAdmission {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return REFUSED
  }
  if (parsed.protocol === 'about:' || parsed.protocol === 'data:') return EXACT
  if (parsed.protocol === 'blob:') return embedAdmissionKind(parsed.pathname, patterns)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return REFUSED
  let wildcardMatch = false
  let localMatch: EmbedAdmission | undefined
  for (const pattern of patterns) {
    if (pattern === ANY_SITE) {
      if (reachableByWildcard(parsed.hostname)) wildcardMatch = true
      continue
    }
    if (pattern === parsed.origin) return EXACT
    const local = parseLocalPattern(pattern)
    if (local !== null && parsed.protocol === 'http:' && localLabelMatches(parsed, local)) {
      localMatch = { kind: 'local', port: local.port }
    }
  }
  if (localMatch !== undefined) return localMatch
  return wildcardMatch ? { kind: 'wildcard', hostname: parsed.hostname } : REFUSED
}

/** Whether `url`'s host is exactly one DNS label followed by the pattern's suffix, on its port. */
function localLabelMatches (url: URL, local: LocalPattern): boolean {
  if (url.port !== String(local.port) || !url.hostname.endsWith(local.suffix)) return false
  return SINGLE_LABEL.test(url.hostname.slice(0, url.hostname.length - local.suffix.length))
}

/**
 * Whether a page shown under `patterns` may load a document at `url`, in
 * its top frame or a frame inside it. Subresources are never judged here.
 * Built on `embedAdmissionKind`: a URL that does not parse, or matches no
 * pattern, is refused, never passed through.
 */
export function embedDocumentAllowed (url: string, patterns: readonly Pattern[]): boolean {
  return embedAdmissionKind(url, patterns).kind !== 'refused'
}
