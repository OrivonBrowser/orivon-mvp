// Capability checking at the call site -- docs/development/testing.md SS1, the
// first of the six security-critical areas, and security-model.md T12.
//
// THE ONE IDEA, stated before anything else, because a perfectly correct
// pattern matcher placed in the wrong order is worth nothing:
//
//   Patterns are matched against WHAT THE HOST RESOLVES TO, never against the
//   hostname the app supplied.
//
// An app declares `evil.example:443`, the user grants it, the app calls
// connect('evil.example'), and a TTL-0 nameserver answers 127.0.0.1. A checker
// that compares the string the app passed against the string in the manifest
// says yes, and the app is now talking to the user's own machine. The matcher
// was never wrong. It was asked the wrong question.
//
// So the order below is fixed and load-bearing: RESOLVE ONCE, check EVERY
// address that came back, and hand the caller the validated literals to dial.
// An allow carries those literals precisely so the broker never names the host
// a second time -- naming it again is a second resolution, and a second
// resolution can answer differently from the first.
//
// The resolver is INJECTED for the same reason this whole directory is pure
// (./README.md): no `electron`, no `node:dns`, no `node:net`, no I/O. That is
// what makes the tests in ./connect.test.ts cheap enough to actually exist,
// and a security check nobody can afford to test is a security check nobody
// has.
//
// EVERY ADDRESS THAT LEAVES HERE IS A CANONICAL LITERAL. `isCanonicalLiteral`
// (./canonical-host.ts) is what makes the paragraph above true rather than
// merely intended -- see its own comment. Without it this function can hand
// the broker a string like `2130706433`, which every stack agrees means
// 127.0.0.1 but which `net.isIP` rejects, so `net.connect` treats it as a NAME
// and looks it up again. That is the rebinding window reopened one layer
// below the check that exists to close it, and whether it bites depends on
// which numeric parser the dialer happens to use -- exactly the inherited
// guarantee ./address.ts warns against. Found by review, 2026-08-27.
//
// WHAT THIS FUNCTION TAKES -- read this before wiring it up.
//
// The GRANTED patterns, not the manifest. The manifest DECLARES what an app
// may ask for, the user GRANTS what it actually gets
// (../../contracts/manifest.ts), and the two sets are not the same: a
// manifest may declare `["*:*", "192.168.1.50:5000"]` while the user granted
// only the first. This function used to take the whole Manifest and read
// `capabilities.net.tcp.connect` out of it, which meant a caller that passed
// the manifest it fetched handed over the DECLARED authority, silently -- the
// exact failure this subsystem exists to prevent. Resolved 2026-08-27, owner
// decision (docs/open-questions.md A18): the first parameter is the already-
// narrowed `readonly Pattern[]` of what was actually granted. The narrowing
// now has nowhere else to happen, so passing the wrong set is a type error at
// the call site rather than a silent over-grant -- the same standard
// ConnectAllowed already holds the output side to, of making "dial the
// literal you checked" structural rather than documented.
//
// The caller (the broker, once it exists) still owns reading the manifest's
// declaration, running the grant-subset check (capability-api.md A9 SS2), and
// handing this function only the result. This function no longer parses a
// Manifest at all, so it has nothing to say about whether a declaration is
// well-formed -- that shape-defensiveness moved with the parsing to the
// caller.
//
// SCOPE. `tcp.connect` only -- see ./connect-patterns.ts for the grammar this
// shares with `udp.send`. `tcp.listen` and `udp.bind` are a DIFFERENT decision
// (bare port ranges, `"*"` rejected, privileged ports denied outright) and get
// their own function rather than a mode flag on this one, because the two
// share a grammar and nothing else. Taking a plain pattern list rather than a
// Manifest is what makes the `udp.send` reuse real: this function no longer
// reads `net.tcp.connect` by name, so a caller can hand it `net.udp.send`'s
// granted patterns just as well -- not wired up here, since that is new
// scope, not part of this signature change.
//
// Split into three files (docs/development/code-guidelines.md Rule 2):
// ./canonical-host.ts (string-level validators, no imports), ./connect-
// patterns.ts (the pattern grammar and matching), and this file (the result
// contract and checkConnect's orchestration).

import type { OrivonErrorCode, Pattern } from '../../contracts/index.js'
import { classifyAddress } from './address.js'
import { MAX_HOST_LENGTH, isAsciiHost, isCanonicalLiteral, isValidPort, normalizeHost } from './canonical-host.js'
import { couldAnyPatternMatch, parsePattern, patternAuthorises } from './connect-patterns.js'

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
 * the grant genuinely could have allowed. Found by review, 2026-08-27.
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
   * Every element satisfies `isCanonicalLiteral`, so `net.isIP` accepts it
   * and no dialer will re-resolve it. Deduplicated, and never longer than
   * MAX_ANSWERS.
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
 * happened. The earlier version of this file returned one shared frozen
 * object and told the broker its denial log "has everything it needs --
 * classifyAddress names the range". That was false twice over: this function
 * owns the resolution, so the broker holds no addresses to classify and would
 * have to resolve a SECOND time to log anything, which is the one thing the
 * header forbids; and most denials have no interesting address anyway. Fixed
 * after review, 2026-08-27, by mirroring ./paths.ts, which faced the same
 * question and answered it this way.
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
 * Found by review, 2026-08-27.
 */
const MAX_PATTERNS = 256
const MAX_ANSWERS = 64

/**
 * Decides whether `patterns` -- the GRANTED pattern list, not the manifest's
 * declared one (see the file header, and docs/open-questions.md A18) --
 * authorises an outbound TCP connection to `hostArg`:`port`, resolving
 * through the injected `resolveFn`.
 *
 * Resolves once, requires EVERY returned address to pass, and returns the
 * validated canonical literals for the caller to dial. One bad answer denies
 * the whole connection -- a host that answers 93.184.216.34 and 127.0.0.1 is a
 * host mounting the attack, and Node 24's `autoSelectFamily: true` means the
 * caller may well pick the second one.
 *
 * Never throws on its own account. A rejection from `resolveFn` propagates:
 * see the note on Resolver.
 */
export async function checkConnect (
  patterns: readonly Pattern[],
  hostArg: string,
  port: number,
  resolveFn: Resolver
): Promise<ConnectDecision> {
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
  const parsed = patterns.map(parsePattern)

  // An address literal is already the thing patterns are matched against, so
  // there is nothing to resolve -- and not calling out means not depending on
  // how a resolver treats a literal. It is still checked identically below;
  // the shortcut skips the lookup, never the policy.
  const literalClass = classifyAddress(requested)
  const isLiteral = literalClass !== 'unparseable'
  // An address this file will not hand onward is one it will not accept as an
  // argument either. Denying rather than falling through to the resolver
  // matters: `2130706433` is a perfectly good DNS label, so treating it as a
  // name would send it to the nameserver.
  if (isLiteral && !isCanonicalLiteral(requested)) return deny('non-canonical-host')

  if (!couldAnyPatternMatch(parsed, requested, port)) return deny('no-pattern-possible')

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

    // Every answer must be a CANONICAL address literal. The caller dials what
    // this function returns, so anything a dialer would resolve again is the
    // rebinding window reopened one layer down -- and `net.isIP` rejects far
    // more strings than ./address.ts parses. See canonical-host.ts's
    // isCanonicalLiteral.
    if (!isCanonicalLiteral(address)) return deny('bad-answer', [...addresses, address])

    if (!parsed.some((pattern) => patternAuthorises(pattern, requested, address, port))) {
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
