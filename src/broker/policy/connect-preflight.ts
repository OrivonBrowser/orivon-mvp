// The checks `checkConnect` and `checkConnectSecure` must both make, in one
// place (docs/open-questions.md A130; owner decision d-I, 2026-09-12).
//
// WHY THIS FILE EXISTS, AND IT IS NOT TIDINESS. The two pipelines each carried
// their own copy of this prologue, and that duplication produced a CRITICAL:
// the reserved-port carve-out was defeated by cross-pattern matching, the fix
// was written against the plain path, and the TLS path kept the hole while the
// fix looked complete. Measured at the time: a grant of
// ['mail.example.com:25', '*:*'] reached an unrelated host on port 25 through
// checkConnectSecure after checkConnect had been fixed. One copy of a rule
// cannot be half-fixed.
//
// WHAT DELIBERATELY STAYS SPLIT. Only the prologue is shared. The two tails are
// genuinely different decisions, not duplication:
//   - plain connect RESOLVES the host and must authorise every address it got
//     back, because nothing else binds the name to the endpoint;
//   - TLS connect matches the requested NAME, because the certificate is what
//     binds identity, and the address it happens to resolve to is not the
//     thing being trusted.
// Collapsing those two would be the opposite mistake: pretending one rule
// covers two different threat models.

import { canonicalAddress, classifyAddress } from './address.js'
import { MAX_HOST_LENGTH, isAsciiHost, isValidPort, normalizeHost } from './canonical-host.js'
import { parsePattern } from './connect-patterns.js'
import type { ParsedPattern } from './connect-patterns.js'
import { isReservedPort, patternNamesPortExactly } from './reserved-ports.js'
import type { Pattern } from '../../contracts/index.js'

/** Every pattern list is bounded before it is parsed -- an app declares its own patterns, so the count is attacker-influenced. */
export const MAX_PATTERNS = 256

/** The reasons a request can be refused before either pipeline's own tail runs. Both pipelines' public reason unions are supersets of this. */
export type PreflightDenialReason =
  | 'not-declared'
  | 'too-many-patterns'
  | 'bad-port'
  | 'bad-host'
  | 'non-canonical-host'
  | 'reserved-port'

export interface PreflightPassed {
  readonly ok: true
  /** The host as normalised -- lowercased, trailing dot removed. Both tails must use THIS, never the caller's original string. */
  readonly requested: string
  /**
   * The parsed patterns, with any that cannot authorise this port replaced by
   * `null`. PER-PATTERN, which is the whole point: on a reserved port a pattern
   * survives only if it names that exact port itself, so one pattern's naming
   * can never stand in for a different pattern's host authorisation.
   */
  readonly eligible: ReadonlyArray<ParsedPattern | null>
  /** True when `requested` is an address literal rather than a name, so the caller knows whether resolution is even meaningful. */
  readonly isLiteral: boolean
}

export interface PreflightDenied {
  readonly ok: false
  readonly reason: PreflightDenialReason
}

export type PreflightResult = PreflightPassed | PreflightDenied

/**
 * `parsedPatterns` is an optional pre-parsed cache for the same list, used only
 * when its length matches -- a mismatch means it is for a different list and is
 * ignored rather than trusted.
 *
 * ORDER IS PART OF THE CONTRACT. Request validation comes before anything that
 * consults the grant: a malformed host is reported as `bad-host` or
 * `non-canonical-host` without the grant's contents influencing the answer at
 * all. `reserved-port` -- which does depend on what was granted -- is checked
 * after. `checkConnect` used to do these the other way round, so a
 * non-canonically-spelled literal on a reserved port reported `reserved-port`
 * there and `non-canonical-host` through the TLS path. One order now, and this
 * is the one, because a caller should not learn anything about a grant from a
 * request that was never valid.
 */
export function preflightConnect (
  patterns: readonly Pattern[],
  hostArg: string,
  port: number,
  parsedPatterns?: ReadonlyArray<ParsedPattern | null>
): PreflightResult {
  if (!Array.isArray(patterns)) return { ok: false, reason: 'not-declared' }

  // An empty list denies, whether nothing was ever declared or the user
  // granted none of what was declared -- absence means absence, never
  // default-allow (capability-api.md design rules 4 and 5). Which of those it
  // was is the caller's concern, not this function's.
  if (patterns.length === 0) return { ok: false, reason: 'not-declared' }
  if (patterns.length > MAX_PATTERNS) return { ok: false, reason: 'too-many-patterns' }

  if (typeof hostArg !== 'string') return { ok: false, reason: 'bad-host' }
  if (!isValidPort(port)) return { ok: false, reason: 'bad-port' }

  const requested = normalizeHost(hostArg)
  if (requested.length === 0 || requested.length > MAX_HOST_LENGTH) return { ok: false, reason: 'bad-host' }
  if (!isAsciiHost(requested)) return { ok: false, reason: 'bad-host' }

  // classifyAddress, not canonicalAddress, decides isLiteral: classifyAddress
  // still recognises a zone-scoped literal (`fe80::1%eth0`) as an address --
  // permissive on purpose, so it can be DENIED as one -- while canonicalAddress
  // returns null for it (see address.ts). Deciding isLiteral from
  // canonicalAddress instead would make that null fall through to the resolver,
  // demoting a recognised, malformed address to a hostname lookup: exactly the
  // fallthrough the next line exists to rule out.
  const isLiteral = classifyAddress(requested) !== 'unparseable'
  // An address a caller will not hand onward is one it will not accept as an
  // argument either. Denying rather than falling through to the resolver
  // matters: `2130706433` is a perfectly good DNS label, so treating it as a
  // name would send it to the nameserver. canonicalAddress NORMALISES
  // (docs/open-questions.md A20), so the check is equality with the input, not
  // merely "did it parse".
  if (isLiteral && canonicalAddress(requested) !== requested) return { ok: false, reason: 'non-canonical-host' }

  // Parsed ONCE, not per address. The plain pipeline's loop is
  // O(answers x patterns) and both counts are chosen by somebody else;
  // re-splitting every pattern inside it made a single call cost seconds.
  const parsed = parsedPatterns !== undefined && parsedPatterns.length === patterns.length
    ? parsedPatterns
    : patterns.map(parsePattern)

  // AFTER parsing and before either tail runs. Before, so a reserved port is
  // never a name-existence oracle (the same reason couldAnyPatternMatch denies
  // early); after, because the answer depends on whether any pattern NAMED this
  // port, which needs them parsed.
  //
  // NARROWS the pattern set rather than merely gating on it: both tails use
  // `eligible`, never `parsed`, so a reserved port can only be authorised by
  // the SAME pattern that named it -- never by pairing that naming with a
  // different, broader pattern's host match. That pairing was A82's
  // cross-pattern bypass, and it is the reason this whole file exists: the fix
  // was applied to one pipeline while the other kept the hole.
  const reserved = isReservedPort(port)
  const eligible = reserved
    ? parsed.map((pattern) => (patternNamesPortExactly(pattern, port) ? pattern : null))
    : parsed
  if (reserved && eligible.every((pattern) => pattern === null)) return { ok: false, reason: 'reserved-port' }

  return { ok: true, requested, eligible, isLiteral }
}
