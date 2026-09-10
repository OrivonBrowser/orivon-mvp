// Capability checking at the call site -- testing.md's six security-critical
// areas (the first), and security-model.md T12.
//
// THE ONE IDEA, stated before anything else, because a perfectly correct
// pattern matcher placed in the wrong order is worth nothing:
//
//   Patterns are matched against WHAT THE HOST RESOLVES TO, never against the
//   hostname the app supplied.
//
// An app declares `evil.example:443`, the user grants it, the app calls
// connect('evil.example'), and a TTL-0 nameserver answers 127.0.0.1. A
// checker comparing strings says yes, and the app is now talking to the
// user's own machine. The matcher was never wrong -- it was asked the wrong
// question.
//
// So the order below is fixed and load-bearing: RESOLVE ONCE, check EVERY
// address that came back, and hand the caller the validated literals to
// dial -- see ConnectAllowed.addresses's own comment for why the allow
// branch carries data instead of a bare boolean.
//
// Takes the GRANTED patterns only, never the manifest's declared ones (see
// checkConnect's own comment, A18). SCOPE (tcp.connect vs tcp.listen/
// udp.bind): see ./connect-patterns.ts's header. Split into three files
// (Rule 2): ./canonical-host.ts, ./connect-patterns.ts, this file. Pure by
// construction like the rest of this directory (./README.md).

import type { OrivonErrorCode, Pattern } from '../../contracts/index.js'
import { canonicalAddress, classifyAddress } from './address.js'
import { MAX_HOST_LENGTH, isAsciiHost, isValidPort, normalizeHost } from './canonical-host.js'
import { couldAnyPatternMatch, parsePattern, patternAuthorises } from './connect-patterns.js'
import type { ParsedPattern } from './connect-patterns.js'
import { isReservedPort, patternNamesPortExactly } from './reserved-ports.js'

/**
 * Resolves a hostname to every address it currently answers with.
 *
 * ASYNC because every real implementation is, and a synchronous signature
 * would push resolution back out to the caller -- which is exactly the split
 * that lets a broker check one set of addresses and connect to another.
 *
 * A resolution FAILURE is not a denial and must not be reported as one: it is
 * 'unreachable' with a platformCode, an attempt the app was permitted to make
 * (../../contracts/errors.ts). So a rejection propagates out of checkConnect
 * for the broker to map, rather than being flattened into 'denied' here. Both
 * outcomes fail closed; only one of them tells honest Node code why its retry
 * loop should give up.
 *
 * THE PRICE OF THAT, AND WHY THE GATE BELOW EXISTS. Two outcomes an app can
 * tell apart is an oracle: "name exists" and "name does not exist" are
 * distinguishable whatever this function returns. `couldAnyPatternMatch`
 * denies BEFORE resolving whenever no granted pattern could authorise the
 * request however it resolved, so the oracle is reachable only for requests
 * the grant genuinely could have allowed.
 */
export type Resolver = (host: string) => Promise<readonly string[]>

export interface ConnectAllowed {
  readonly allowed: true
  /**
   * The addresses to dial, canonical and already validated.
   *
   * DIAL THESE, never `hostArg`. This is the second half of the T12
   * mitigation and the reason the allow branch -- not the denial branch --
   * is the one carrying data: a broker physically cannot proceed without
   * destructuring this, so "resolve, check, then connect to the literal"
   * is enforced by the shape of the return value rather than by a comment
   * somebody has to remember to read.
   *
   * Every element equals its own `canonicalAddress(...)`, so `net.isIP`
   * accepts it and no dialer will re-resolve it. Deduplicated, and never
   * longer than MAX_ANSWERS.
   */
  readonly addresses: readonly string[]
}

/**
 * Why a connection was refused. FOR THE BROKER'S LOCAL LOG ONLY. It must
 * never reach the renderer.
 *
 * ../../contracts/errors.ts on 'denied': "If denials varied by reason, an app
 * could iterate through them and map exactly which pattern, port or address
 * class is blocked, turning the permission boundary itself into a probe
 * target." That is still true, and it is a statement about what crosses IPC,
 * which is where the broker flattens every one of these to a bare
 * `{ code: 'denied' }`.
 *
 * It is NOT an argument for the decision function being unable to say what
 * happened: `reason` and `checked` (on ConnectDenied, below) exist precisely
 * so the broker's local log can say something specific without resolving a
 * SECOND time to get it -- the one thing the header forbids. Same answer
 * ./paths.ts gives to the identical question.
 *
 * Closed union rather than a free-form string so the broker's logging switch
 * is exhaustive and a new reason cannot be added without every call site being
 * told about it. Same reasoning as OrivonErrorCode, one layer down.
 */
export type ConnectDenialReason =
  /** No granted patterns, or an empty list. Absence means absence. */
  | 'not-declared'
  /** More patterns than MAX_PATTERNS. Fail closed rather than scan them. */
  | 'too-many-patterns'
  /** `port` was not an integer in 1..65535. */
  | 'bad-port'
  /** `hostArg` was not a string, was empty, was over-long, or was not ASCII. */
  | 'bad-host'
  /** `hostArg` was an address, but written in a non-canonical encoding. */
  | 'non-canonical-host'
  /** No granted pattern could authorise this host and port however it resolved. */
  | 'no-pattern-possible'
  /** The resolver returned nothing. `[].every(ok)` is true; this is not. */
  | 'empty-resolution'
  /** More answers than MAX_ANSWERS. */
  | 'too-many-answers'
  /** An answer was not a string, or not a canonical address literal. */
  | 'bad-answer'
  /** Answers were fine; no pattern matched one of them at this port. */
  | 'no-pattern-match'
  /** The port is one no blanket grant reaches, and no pattern named it exactly (A82). */
  | 'reserved-port'

export interface ConnectDenied {
  readonly allowed: false
  /**
   * Always 'denied', never anything else.
   *
   * Typed through OrivonErrorCode so that renaming the code in
   * ../../contracts/errors.ts breaks this build instead of silently leaving
   * the broker emitting a string no app switches on.
   */
  readonly code: Extract<OrivonErrorCode, 'denied'>
  /** LOCAL LOG ONLY. Never send this, or anything derived from it, to an app. */
  readonly reason: ConnectDenialReason
  /**
   * The addresses that were actually checked, when the denial happened late
   * enough for there to be any. LOCAL LOG ONLY, same rule as `reason`.
   *
   * Present so the broker can write "app X was denied 10.0.0.5:22" without
   * resolving the name a second time -- which is the thing the header
   * forbids, and which the previous design silently required.
   */
  readonly checked?: readonly string[]
}

export type ConnectDecision = ConnectAllowed | ConnectDenied

function deny (reason: ConnectDenialReason, checked?: readonly string[]): ConnectDenied {
  return checked === undefined
    ? { allowed: false, code: 'denied', reason }
    : { allowed: false, code: 'denied', reason, checked }
}

/**
 * Bounds on the two lists whose length is chosen by somebody else.
 *
 * Item LENGTHS were already bounded; item COUNTS were not, and the work is
 * their product. Measured before this bound existed: 20000 patterns against
 * 1000 answers took 13.9 SECONDS of synchronous CPU in one checkConnect call,
 * on the broker's UI thread -- security-model.md T11b by name, and LIMITS'
 * in-flight cap bounds the number of operations rather than the cost of one.
 * Pattern count is grant-controlled (bounded by what the manifest declared
 * and the user then granted); answer count is DNS-controlled.
 *
 * Both are far above anything real: the flagship declares one pattern, and a
 * round-robin CDN answers with a handful of addresses. Exceeding either
 * denies, which is the same direction everything else here fails.
 */
// Exported so a second consumer (../policy/connect-src.ts's CSP `connect-src`
// derivation) enforces the same bound instead of a second copy of 256 that
// can drift from this one.
export const MAX_PATTERNS = 256
// Exported so a second consumer (../../loader/install-origin.ts's T12 guard,
// which resolves once against the same kind of untrusted answer count) shares
// this bound instead of a second copy that can drift from it (Rule 3).
export const MAX_ANSWERS = 64

/**
 * Decides whether `patterns` -- the GRANTED pattern list, never the
 * manifest's DECLARED one (the two differ whenever the user granted less
 * than an app asked for; A18) -- authorises an outbound TCP connection to
 * `hostArg`:`port`, resolving through the injected `resolveFn`. The caller
 * owns reading the manifest and running the grant-subset check
 * (capability-api.md A9's second section); this function only sees the
 * result and has nothing to say about whether a declaration is well-formed.
 *
 * Resolves once, requires EVERY returned address to pass, and returns the
 * validated canonical literals for the caller to dial. One bad answer denies
 * the whole connection -- a host that answers 93.184.216.34 and 127.0.0.1 is a
 * host mounting the attack, and Node 24's `autoSelectFamily: true` means the
 * caller may well pick the second one.
 *
 * Never throws on its own account. A rejection from `resolveFn` propagates:
 * see the note on Resolver.
 *
 * `parsedPatterns`, when supplied, MUST be `patterns.map(parsePattern)` for
 * this exact `patterns` array -- a caller checking the same grant repeatedly
 * (GrantLedger.parsedPatternsFor, for authorisedSend's per-datagram udp.send
 * check in ../index.ts) may pass its cached result instead of paying to
 * redo it on every call. A length mismatch means the two arguments do not
 * actually correspond, so this parses fresh rather than trusting a caller's
 * mistake -- every OTHER validation and the live resolve below are unchanged
 * either way.
 */
export async function checkConnect (
  patterns: readonly Pattern[],
  hostArg: string,
  port: number,
  resolveFn: Resolver,
  parsedPatterns?: ReadonlyArray<ParsedPattern | null>
): Promise<ConnectDecision> {
  // Runtime shape guard, kept for the same reason hostArg and answer each get
  // one below: the type signature is a compile-time promise, not a runtime
  // one. `patterns` is GrantLedger's rehydration of a persisted grant store
  // -- untrusted JSON shape -- and this function's own doc comment promises
  // it never throws on its own account, so anything other than a real array
  // (a bare string, null, undefined, a whole Manifest) denies instead of
  // throwing out of `.length` or `.map`.
  if (!Array.isArray(patterns)) return deny('not-declared')

  // An empty list denies, whether nothing was ever declared or the user
  // granted none of what was declared -- absence means absence, never
  // default-allow (capability-api.md design rules 4 and 5). Which of those
  // it was is the caller's concern, not this function's: it no longer parses
  // a Manifest, so it cannot and does not distinguish them.
  if (patterns.length === 0) return deny('not-declared')
  if (patterns.length > MAX_PATTERNS) return deny('too-many-patterns')

  if (typeof hostArg !== 'string') return deny('bad-host')
  if (!isValidPort(port)) return deny('bad-port')

  const requested = normalizeHost(hostArg)
  if (requested.length === 0 || requested.length > MAX_HOST_LENGTH) return deny('bad-host')
  if (!isAsciiHost(requested)) return deny('bad-host')

  // Parsed ONCE, not per address. The loop below is O(answers x patterns) and
  // both counts are chosen by somebody else; re-splitting every pattern inside
  // it made a single call cost seconds. See MAX_PATTERNS.
  const parsed = parsedPatterns !== undefined && parsedPatterns.length === patterns.length
    ? parsedPatterns
    : patterns.map(parsePattern)

  // Checked HERE -- after parsing, before resolving. Before, so a reserved
  // port is never a name-existence oracle (the same reason
  // couldAnyPatternMatch denies early); after, because the answer depends on
  // whether any pattern NAMED this port, which needs them parsed.
  //
  // NARROWS the pattern set rather than merely gating on it: every downstream
  // check below uses `eligible`, not `parsed`, so a reserved port can only be
  // authorised by the SAME pattern that named it -- never by pairing that
  // naming with a different, broader pattern's host match (A82's
  // cross-pattern bypass; see reserved-ports.ts's own doc comment).
  const reserved = isReservedPort(port)
  const eligible = reserved
    ? parsed.map((pattern) => (patternNamesPortExactly(pattern, port) ? pattern : null))
    : parsed
  if (reserved && eligible.every((pattern) => pattern === null)) return deny('reserved-port')

  // An address literal is already the thing patterns are matched against, so
  // there is nothing to resolve -- and not calling out means not depending on
  // how a resolver treats a literal. It is still checked identically below;
  // the shortcut skips the lookup, never the policy.
  //
  // classifyAddress, not canonicalAddress, decides isLiteral: classifyAddress
  // still recognises a zone-scoped literal (`fe80::1%eth0`) as an address --
  // permissive on purpose, so it can be denied as one -- while
  // canonicalAddress returns null for it (see address.ts). Deciding isLiteral
  // from canonicalAddress instead would make that null fall through to the
  // resolver, demoting a recognised, malformed address to a hostname lookup:
  // exactly the fallthrough the next line exists to rule out.
  const isLiteral = classifyAddress(requested) !== 'unparseable'
  // An address this file will not hand onward is one it will not accept as an
  // argument either. Denying rather than falling through to the resolver
  // matters: `2130706433` is a perfectly good DNS label, so treating it as a
  // name would send it to the nameserver. canonicalAddress NORMALISES
  // (docs/open-questions.md A20), so the check is equality with the input,
  // not merely "did it parse" -- see this file's header.
  if (isLiteral && canonicalAddress(requested) !== requested) return deny('non-canonical-host')

  if (!couldAnyPatternMatch(eligible, requested, port)) return deny('no-pattern-possible')

  const answers = isLiteral ? [requested] : await resolveFn(requested)

  // Fail closed on an empty answer. `[].every(...)` is TRUE, and a check built
  // on it would wave through exactly the host whose nameserver returned
  // nothing.
  if (answers.length === 0) return deny('empty-resolution')
  if (answers.length > MAX_ANSWERS) return deny('too-many-answers')

  const addresses: string[] = []
  for (const answer of answers) {
    if (typeof answer !== 'string') return deny('bad-answer', addresses)

    const address = normalizeHost(answer)

    // Every answer must be a CANONICAL address literal, spelled exactly the
    // way canonicalAddress would spell it -- not merely something it can
    // parse. The caller dials what this function returns, so anything a
    // dialer would resolve again is the rebinding window reopened one layer
    // down, and a real resolver always answers in canonical form: this
    // asserts the guarantee is enforced here rather than only inherited from
    // that assumption. See address.ts's canonicalAddress.
    if (canonicalAddress(address) !== address) return deny('bad-answer', [...addresses, address])

    if (!eligible.some((pattern) => patternAuthorises(pattern, requested, address, port))) {
      return deny('no-pattern-match', [...addresses, address])
    }

    // Deduplicated: a resolver may repeat an address, and the caller opens one
    // socket per element against a documented cap (LIMITS.concurrentSockets).
    if (!addresses.includes(address)) addresses.push(address)
  }

  // Frozen because the gap between deciding and dialling is the only place a
  // validated set can be edited, and nothing downstream re-checks it.
  return Object.freeze({ allowed: true, addresses: Object.freeze(addresses) })
}
