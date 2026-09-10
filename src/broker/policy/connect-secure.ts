// https.connect's own decision function -- a deliberate variant of
// ./connect.ts's checkConnect, not a second copy of its idea. THE ONE THING
// THAT DIFFERS, stated before anything else because it is the whole reason
// this is a separate file rather than a branch inside checkConnect:
//
//   Patterns are matched against THE HOSTNAME THE APP ASKED FOR, never a
//   resolved address.
//
// checkConnect resolves first because nothing else ties a plain TCP peer's
// address to the name an app used to reach it (T12 -- a name is not
// evidence of who answered). connectSecure's own certificate and hostname
// verification (../adapters/tls-adapter.ts, ADR-0017) already does that
// binding cryptographically: a trusted root will not sign a certificate for
// `api.example.com` to whoever DNS happens to hand back. So there is no
// resolver here, no address list, and no `couldAnyPatternMatch` gate -- the
// whole reason that gate exists in checkConnect is to keep a pre-resolve
// existence oracle from opening, and there is no resolve step here for one
// to open around.
//
// Grammar, MAX_PATTERNS, the reserved-port carve-out (A82) and the string
// hygiene (ASCII-only, length-bounded, canonical literals) are all reused
// from ./connect.ts and ./connect-patterns.ts rather than redefined --
// same rules, same reasons, applied to a different comparison.

import type { OrivonErrorCode, Pattern } from '../../contracts/index.js'
import { canonicalAddress, classifyAddress } from './address.js'
import { MAX_HOST_LENGTH, isAsciiHost, isValidPort, normalizeHost } from './canonical-host.js'
import { MAX_PATTERNS } from './connect.js'
import { parsePattern, portMatches } from './connect-patterns.js'
import type { ParsedPattern } from './connect-patterns.js'
import { isReservedPort, namesPortExactly } from './reserved-ports.js'

export interface ConnectSecureAllowed {
  readonly allowed: true
  /**
   * The canonical hostname to dial and to verify the handshake against --
   * SNI and certificate hostname verification both use this exact string
   * (../adapters/tls-adapter.ts). Handed back rather than left for the
   * caller to re-normalise, the same reason checkConnect hands back
   * `addresses` rather than the raw `hostArg`: one normalisation, not two
   * that could drift.
   */
  readonly host: string
}

/**
 * Why a secure connection was refused. LOCAL LOG ONLY, same rule as
 * ./connect.ts's ConnectDenialReason -- never reaches an app, which sees a
 * uniform 'denied' with no platformCode.
 */
export type ConnectSecureDenialReason =
  | 'not-declared'
  | 'too-many-patterns'
  | 'bad-port'
  | 'bad-host'
  | 'non-canonical-host'
  | 'reserved-port'
  | 'no-pattern-match'

export interface ConnectSecureDenied {
  readonly allowed: false
  readonly code: Extract<OrivonErrorCode, 'denied'>
  readonly reason: ConnectSecureDenialReason
}

export type ConnectSecureDecision = ConnectSecureAllowed | ConnectSecureDenied

function deny (reason: ConnectSecureDenialReason): ConnectSecureDenied {
  return { allowed: false, code: 'denied', reason }
}

/**
 * One pattern's host part against the requested hostname. `'*'` authorises
 * any host -- ADR-0017's unlimited-HTTPS declaration -- because there is no
 * address class left to narrow it against, unlike checkConnect's own
 * `isPublicUnicast` gate on the resolved answer: the certificate check is
 * what stands in for that here, for every host alike, including `'*'`.
 *
 * Every other pattern (hostname or address-literal) requires an EXACT
 * string match against the normalised request -- no sub-glob support, same
 * as connect-patterns.ts's own `hostMatches`, and no separate address-class
 * rule for a literal: an app that named a literal in its https.connect
 * grant gets exactly that literal, nothing it might resolve to.
 */
function hostMatchesSecure (parsed: ParsedPattern | null, requested: string, port: number): boolean {
  if (parsed === null) return false
  if (!portMatches(parsed.port, port)) return false
  if (parsed.host === '*') return true
  return normalizeHost(parsed.host) === requested
}

/**
 * Decides whether `patterns` -- the GRANTED `https.connect` patterns, never
 * the manifest's declared ones (checkConnect's own A18 rule, unchanged
 * here) -- authorise a TLS-secured connection to `hostArg`:`port`.
 *
 * SYNCHRONOUS, unlike checkConnect: there is no resolver to await. Never
 * throws on its own account, for the same reason checkConnect does not --
 * `patterns` is GrantLedger's rehydration of persisted JSON, untrusted
 * shape despite the compile-time type.
 */
export function checkConnectSecure (
  patterns: readonly Pattern[],
  hostArg: string,
  port: number
): ConnectSecureDecision {
  if (!Array.isArray(patterns)) return deny('not-declared')
  if (patterns.length === 0) return deny('not-declared')
  if (patterns.length > MAX_PATTERNS) return deny('too-many-patterns')

  if (typeof hostArg !== 'string') return deny('bad-host')
  if (!isValidPort(port)) return deny('bad-port')

  const requested = normalizeHost(hostArg)
  if (requested.length === 0 || requested.length > MAX_HOST_LENGTH) return deny('bad-host')
  if (!isAsciiHost(requested)) return deny('bad-host')

  // An address literal must be written canonically -- same reasoning as
  // checkConnect's own guard on `hostArg`: `203.000.113.5` is not the
  // literal a manifest pattern would have been shown as, and accepting it
  // here would let a caller name one address two different ways.
  if (classifyAddress(requested) !== 'unparseable' && canonicalAddress(requested) !== requested) {
    return deny('non-canonical-host')
  }

  const parsed = patterns.map(parsePattern)

  // Checked before matching, exactly where checkConnect checks it: A82's
  // rule applies to https.connect too, and it depends only on `parsed` and
  // `port`, never on the address side of anything.
  if (isReservedPort(port) && !namesPortExactly(parsed, port)) return deny('reserved-port')

  if (!parsed.some((pattern) => hostMatchesSecure(pattern, requested, port))) {
    return deny('no-pattern-match')
  }

  return Object.freeze({ allowed: true, host: requested })
}
