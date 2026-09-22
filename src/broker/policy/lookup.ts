// orivon.net.lookup's own decision function (d-0030) -- a THIRD variant
// alongside ./connect.ts's resolved-address check and ./connect-secure.ts's
// certificate-backed name check, not a copy of either. THE ONE THING THAT
// DIFFERS, stated first:
//
//   `hostname` is checked against the HOST PORTION of a pattern ONLY --
//   never a port (lookup has none), and never a resolved address (this
//   function decides whether to resolve at all).
//
// A82's reserved-port carve-out does not apply here for the same reason: it
// narrows which PORT a pattern reaches, and this function never reaches for
// one. Grammar and string hygiene reused from ./connect-patterns.ts and
// ./canonical-host.ts (code-guidelines.md Rule 3). Why a host-only check
// still opens nothing new: ../README.md, Design notes, "lookup.ts".

import type { LookupAddress, OrivonErrorCode, Pattern } from '../../contracts/index.js'
import { MAX_HOST_LENGTH, isAsciiHost, normalizeHost } from './canonical-host.js'
import { LOCALHOST, hostSpecKind, parsePattern } from './connect-patterns.js'
import type { ParsedPattern } from './connect-patterns.js'
import { MAX_PATTERNS } from './connect-preflight.js'

export interface LookupAllowed {
  readonly allowed: true
  /** The host as normalised -- lowercased, trailing dot removed. Resolve THIS, never the caller's raw string. */
  readonly hostname: string
  /** Present for `localhost` under a pattern naming it: the answer itself, returned instead of resolving (./connect-patterns.ts's LOOPBACK_LITERALS). */
  readonly answers?: readonly LookupAddress[]
}

const LOCALHOST_ANSWERS: readonly LookupAddress[] = Object.freeze([
  Object.freeze({ address: '127.0.0.1', family: 'IPv4' as const }),
  Object.freeze({ address: '::1', family: 'IPv6' as const })
])

/** LOCAL LOG ONLY, same rule as ./connect.ts's ConnectDenialReason -- never reaches an app, which sees a uniform 'denied'. */
export type LookupDenialReason =
  | 'not-declared'
  | 'too-many-patterns'
  | 'bad-host'
  | 'no-pattern-match'

export interface LookupDenied {
  readonly allowed: false
  readonly code: Extract<OrivonErrorCode, 'denied'>
  readonly reason: LookupDenialReason
}

export type LookupDecision = LookupAllowed | LookupDenied

function deny (reason: LookupDenialReason): LookupDenied {
  return { allowed: false, code: 'denied', reason }
}

/**
 * One pattern's host part against the requested name. `'*'` authorises any
 * name -- d-0030's own "unlimited network, unlimited lookups" reading --
 * whatever port that `*` happens to be paired with (this file's header: a
 * lookup has no port to narrow it by). A hostname pattern requires an exact
 * match. An address literal never authorises a NAME (nothing resolves to
 * itself, so a literal grant names no lookupable name at all), and a
 * sub-glob authorises nothing -- both matching hostSpecKind's own contract.
 */
function hostAuthorisesLookup (parsed: ParsedPattern | null, requested: string): boolean {
  if (parsed === null) return false
  const kind = hostSpecKind(parsed.host)
  if (kind === 'any-public-unicast') return true
  if (kind === 'hostname') return normalizeHost(parsed.host) === requested
  return false
}

/**
 * Decides whether `patterns` -- already the UNION of every outbound grant's
 * patterns the caller holds (`../net-capability.ts`'s own `lookup`:
 * `tcp.connect` + `udp.send`, d-0030 narrowed by d-0031 to exclude
 * `https.connect` -- see `docs/open-questions.md` A190/A193), never a
 * manifest's declared ones -- authorises resolving `hostnameArg`.
 *
 * Never throws on its own account, matching every sibling in this
 * directory: `patterns` is a grant's rehydrated JSON, untrusted shape
 * despite the compile-time type.
 */
export function checkLookup (patterns: readonly Pattern[], hostnameArg: string): LookupDecision {
  if (!Array.isArray(patterns) || patterns.length === 0) return deny('not-declared')
  if (patterns.length > MAX_PATTERNS) return deny('too-many-patterns')
  if (typeof hostnameArg !== 'string') return deny('bad-host')

  const requested = normalizeHost(hostnameArg)
  if (requested.length === 0 || requested.length > MAX_HOST_LENGTH || !isAsciiHost(requested)) {
    return deny('bad-host')
  }

  const parsed = patterns.map(parsePattern)
  if (!parsed.some((pattern) => hostAuthorisesLookup(pattern, requested))) return deny('no-pattern-match')

  // Only a pattern that names `localhost` itself earns the loopback answer; a
  // `*` pattern authorises the lookup but can never connect there, so it gets
  // the ordinary resolve-and-filter path, which answers nothing reachable.
  if (requested === LOCALHOST && parsed.some((pattern) => pattern !== null && normalizeHost(pattern.host) === LOCALHOST)) {
    return Object.freeze({ allowed: true, hostname: requested, answers: LOCALHOST_ANSWERS })
  }
  return Object.freeze({ allowed: true, hostname: requested })
}
