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
import { classifyAddress, isPublicUnicast } from './address.js'
import { normalizeHost } from './canonical-host.js'
import { portMatches } from './connect-patterns.js'
import type { ParsedPattern } from './connect-patterns.js'
import { preflightConnect } from './connect-preflight.js'
import { isLocalhostName } from './origin.js'

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
  /**
   * A `'*'` pattern matched host and port, but the requested address
   * literal is not public unicast (A196). Distinct from `'no-pattern-match'`
   * so the broker's local log can say "your grant does not cover this
   * address class" instead of "nothing named this host at all" -- both are
   * denials for the exact same reason checkConnect's own `isPublicUnicast`
   * gate exists, but only one of them tells a debugging app author which
   * rule they hit.
   */
  | 'non-public-address'

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
 * True if `requested` is an address literal (not a hostname) that is NOT
 * ordinary public internet space -- loopback, RFC 1918, link-local
 * (169.254.169.254 included), or any other class `./address.ts`'s
 * `isPublicUnicast` denies for checkConnect. False for a hostname, because
 * this file has no resolver and cannot classify what a name resolves to --
 * see this module's header and A196 for that residual.
 */
function isNonPublicAddressLiteral (requested: string): boolean {
  return classifyAddress(requested) !== 'unparseable' && !isPublicUnicast(requested)
}

/**
 * One pattern's host part against the requested hostname.
 *
 * `'*'` authorises PUBLIC UNICAST ONLY (A196, resolving toward A82/A192's
 * intent) -- matching checkConnect's own `isPublicUnicast` gate on the
 * resolved answer, not the weaker rule this function used to state.
 *
 * THE REASONING THAT USED TO JUSTIFY NO GATE HERE WAS WRONG, and saying so is
 * the point of this comment surviving the fix rather than being deleted: it
 * argued the certificate/hostname check (ADR-0017, ../adapters/tls-adapter.ts)
 * "stands in for" an address-class gate, for every host including `'*'`. It
 * does not, and the reason is specific -- A CERTIFICATE BINDS A NAME, NOT AN
 * ADDRESS. An attacker's own domain, with a valid, publicly-trusted
 * certificate, can point its A record at 127.0.0.1 or 192.168.1.1; TLS
 * validates the name and succeeds regardless of where the socket actually
 * connects. The certificate check and an address-class gate answer two
 * different questions -- "is this really who it claims to be" and "is this
 * address one a `*` grant was ever meant to reach" -- and passing the first
 * says nothing about the second. A stale version of this comment is what let
 * an earlier automated security review clear this exact defect; do not
 * repeat that by trusting a rationale comment over what the code does.
 *
 * THE LIMIT OF WHAT THIS CAN CATCH, because it matters more here than almost
 * anywhere else in this file: this path is SYNCHRONOUS and has no resolver
 * (this module's own header). So the gate above only ever sees the address
 * the app directly asked to connect to -- when `requested` is itself an
 * address literal. A HOSTNAME THAT RESOLVES TO A PRIVATE ADDRESS IS NOT
 * CAUGHT HERE; there is no resolution step in this file for it to be caught
 * at. That is DNS rebinding, the same attack checkConnect's own header names
 * as the reason it resolves before checking. Recorded as an open residual in
 * A196, not papered over.
 *
 * Every other pattern (hostname or address-literal) still requires an EXACT
 * string match against the normalised request -- no sub-glob support, same
 * as connect-patterns.ts's own `hostMatches`, and STILL no address-class
 * rule for a literal: an app that named a literal in its https.connect
 * grant gets exactly that literal, nothing it might resolve to. Only the
 * wildcard narrows -- a person who explicitly granted a specific private
 * address chose that, and this fix does not revisit that choice.
 *
 * A LOOPBACK NAME IS LOOPBACK, and is excluded for the same reason as a
 * loopback literal. RFC 6761 SS6.3 reserves the whole `.localhost` namespace,
 * and Chromium resolves that subtree without consulting DNS at all, so
 * `app.localhost` is as reachable-and-private as `127.0.0.1` --
 * `isLocalhostName` (./origin.ts) is exported precisely so this is the
 * second caller rather than a second copy. This is NOT the unresolved-
 * hostname residual A196 records: that one genuinely cannot be decided
 * without resolving, and this one is decided by the name alone. Leaving it
 * out would have broken the very parity with `checkConnect` this change
 * exists to restore -- the plain path denies `localhost` today, because it
 * resolves first and then fails the address gate.
 */
function hostMatchesSecure (parsed: ParsedPattern | null, requested: string, port: number): boolean {
  if (parsed === null) return false
  if (!portMatches(parsed.port, port)) return false
  if (parsed.host === '*') return !isNonPublicAddressLiteral(requested) && !isLocalhostName(requested)
  return normalizeHost(parsed.host) === requested
}

/** True if some eligible pattern is a bare `'*'` covering `port` -- used only to pick a denial reason, never to decide `allowed` (that stays `hostMatchesSecure`'s job). */
function wildcardEligibleAt (eligible: ReadonlyArray<ParsedPattern | null>, port: number): boolean {
  return eligible.some((pattern) => pattern !== null && pattern.host === '*' && portMatches(pattern.port, port))
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
  // Identical to checkConnect's, because it IS checkConnect's -- one copy of
  // the shared prologue, which is the point of ./connect-preflight.ts. The
  // reserved-port narrowing in particular was fixed on the plain path while
  // this one kept the hole; that cannot happen to one copy.
  const pre = preflightConnect(patterns, hostArg, port)
  if (!pre.ok) return deny(pre.reason)
  const { requested, eligible } = pre

  if (!eligible.some((pattern) => hostMatchesSecure(pattern, requested, port))) {
    // A wildcard pattern matched host and port syntactically, and the only
    // reason it still refused is the address-class gate above -- report
    // that specifically rather than the generic 'no-pattern-match', so a
    // debugging app author (and the broker's own local log) can tell "your
    // grant does not cover this address class" from "nothing named this
    // host at all".
    if (wildcardEligibleAt(eligible, port) && isNonPublicAddressLiteral(requested)) {
      return deny('non-public-address')
    }
    return deny('no-pattern-match')
  }

  return Object.freeze({ allowed: true, host: requested })
}
