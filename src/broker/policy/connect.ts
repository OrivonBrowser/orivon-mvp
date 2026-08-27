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
// below is what makes the paragraph above true rather than merely intended --
// see its own comment. Without it this function can hand the broker a string
// like `2130706433`, which every stack agrees means 127.0.0.1 but which
// `net.isIP` rejects, so `net.connect` treats it as a NAME and looks it up
// again. That is the rebinding window reopened one layer below the check that
// exists to close it, and whether it bites depends on which numeric parser the
// dialer happens to use -- exactly the inherited guarantee ./address.ts warns
// against. Found by review, 2026-08-27.
//
// WHAT THIS FUNCTION DOES NOT CHECK -- read this before wiring it up.
//
// It checks the MANIFEST's declaration. The manifest DECLARES, the user GRANTS
// (../../contracts/manifest.ts), and the two sets are not the same: a manifest
// may declare `["*:*", "192.168.1.50:5000"]` while the user granted only the
// first. Nothing in this signature carries the grant, so before trusting an
// allow the broker must either
//
//   - pass a manifest whose `connect` list has already been narrowed to the
//     granted pattern set, or
//   - run the grant subset check separately (capability-api.md A9 SS2).
//
// Still flagged rather than solved, and now filed as an open question rather
// than left in this comment alone (docs/open-questions.md A16). Taking a
// `readonly Pattern[]` of GRANTED patterns instead of a Manifest would make
// the narrowing structural, the way ConnectAllowed makes "dial the literal"
// structural. That is a signature change and it belongs in its own PR.
//
// SCOPE. `tcp.connect` only. `udp.send` has the same pattern rules
// (manifest.ts); it can reuse every helper here, though not `checkConnect`
// itself, which reads `net.tcp.connect` by name. `tcp.listen` and `udp.bind`
// are a DIFFERENT decision -- bare port ranges, `"*"` rejected, privileged
// ports denied outright -- and get their own function rather than a mode flag
// on this one, because the two share a grammar and nothing else.

import type { Manifest, OrivonErrorCode, Pattern } from '../../contracts/index.js'
import { classifyAddress, isPublicUnicast } from './address.js'

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
 * denies BEFORE resolving whenever no declared pattern could authorise the
 * request however it resolved, so the oracle is reachable only for requests
 * the manifest genuinely could have allowed. Found by review, 2026-08-27.
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
  /** No `tcp.connect` list, or an empty one. Absence means absence. */
  | 'not-declared'
  /** More patterns than MAX_PATTERNS. Fail closed rather than scan them. */
  | 'too-many-patterns'
  /** `port` was not an integer in 1..65535. */
  | 'bad-port'
  /** `hostArg` was not a string, was empty, was over-long, or was not ASCII. */
  | 'bad-host'
  /** `hostArg` was an address, but written in a non-canonical encoding. */
  | 'non-canonical-host'
  /** No declared pattern could authorise this host and port however it resolved. */
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

const MAX_PORT = 65535

/** RFC 1035's limit on a presentation-format domain name. */
const MAX_HOST_LENGTH = 253

/** A host at the limit, a colon, and the widest port range. */
const MAX_PATTERN_LENGTH = 300

/**
 * Bounds on the two lists whose length is chosen by somebody else.
 *
 * Item LENGTHS were already bounded; item COUNTS were not, and the work is
 * their product. Measured before this bound existed: 20000 patterns against
 * 1000 answers took 13.9 SECONDS of synchronous CPU in one checkConnect call,
 * on the broker's UI thread -- security-model.md T11b by name, and LIMITS'
 * in-flight cap bounds the number of operations rather than the cost of one.
 * Pattern count is manifest-controlled; answer count is DNS-controlled.
 *
 * Both are far above anything real: the flagship declares one pattern, and a
 * round-robin CDN answers with a handful of addresses. Exceeding either
 * denies, which is the same direction everything else here fails.
 * Found by review, 2026-08-27.
 */
const MAX_PATTERNS = 256
const MAX_ANSWERS = 64

/**
 * Lower-cases ASCII letters only, strips URL brackets and one trailing root
 * dot, and trims.
 *
 * ASCII-only because that is precisely DNS's rule (RFC 4343) and because
 * `toLowerCase()` applies full Unicode case folding -- U+212A KELVIN SIGN
 * folds to `k`, among others. A comparison whose notion of equality is wider
 * than DNS's is a comparison that can be steered.
 *
 * The trailing dot is the DNS root label: `example.com.` and `example.com` are
 * the same name, and treating them as different names is one string away from
 * a bypass.
 */
function normalizeHost (value: string): string {
  let text = value.trim().replace(/[A-Z]/g, (c) => c.toLowerCase())
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1)
  if (text.length > 1 && text.endsWith('.')) text = text.slice(0, -1)
  return text
}

/**
 * True only for a host made of characters DNS and this file both understand.
 *
 * NON-ASCII IS REJECTED, LOUDLY AND DELIBERATELY. `normalizeHost` folds only
 * ASCII case, for the good reason above, so `api.exÄmple.com` and
 * `api.exämple.com` compare unequal -- and an app that derives its host the
 * normal way, `new URL(...).hostname`, gets the punycode A-label
 * `api.xn--exmple-cua.com`, which matches neither. Three spellings of one
 * name, none of them matching a manifest a human wrote in Unicode.
 *
 * That failed CLOSED, so it was never a hole; it was a trap. The author got a
 * denial with no explanation and no log line. Rejecting the pattern outright
 * is the same argument this file already makes for `*.example.com`: an app
 * author finds a deliberate reject in seconds, and a user never finds a
 * silent non-match at all.
 *
 * Making IDN genuinely work means normalising both sides to A-labels, which
 * needs UTS-46 -- a dependency or a hundred hand-written lines in a directory
 * that is meant to have neither. Recorded in docs/open-questions.md A17.
 * Found by review, 2026-08-27.
 */
function isAsciiHost (value: string): boolean {
  return !/[^\x20-\x7e]/.test(value)
}

/**
 * True only for an address written the one way every stack agrees on: a
 * strict dotted quad, or an RFC 4291 IPv6 literal with no zone id.
 *
 * WHY THIS EXISTS, given ./address.ts already parses addresses. The two
 * answer different questions. `classifyAddress` asks "what range is this in",
 * and it is deliberately PERMISSIVE -- it must understand `0177.0.0.1` and
 * `2130706433` in order to BLOCK them, which is right on the deny side. This
 * file also needs an IDENTITY answer on the ALLOW side: is this string one
 * that everything downstream will read as the same address. Those come apart
 * exactly where it hurts.
 *
 *   - `checkConnect` returns addresses for the broker to dial. `net.isIP`
 *     rejects `2130706433`, so `net.connect` resolves it as a NAME. Verified
 *     end to end before this guard existed: a manifest declaring
 *     `2130706433:22` produced `addresses: ["2130706433"]`, and dialling it
 *     performed a fresh DNS lookup and landed on 127.0.0.1.
 *   - A manifest may declare a private range only by naming it literally,
 *     because the user is shown that literal and grants it. `2130706433:22`
 *     is 127.0.0.1:22 rendered as an opaque number, which defeats the consent
 *     step the rule depends on.
 *
 * A NON-CANONICAL ADDRESS IS REJECTED, NOT DEMOTED TO A HOSTNAME. That
 * distinction is the whole safety of this guard: falling through would let
 * `2130706433` be compared as a name against a `2130706433` pattern host and
 * pass, which is worse than the bug it replaces. Every call site below denies
 * on `classifyAddress(x) !== 'unparseable' && !isCanonicalLiteral(x)`.
 *
 * A VALIDATOR, NOT A SECOND PARSER. It accepts a strict subset and never
 * assigns meaning, so it can only ever narrow what address.ts already
 * decided; a disagreement denies. That is the difference between this and the
 * duplicate parser address.ts's own comments argue against. The architecturally
 * cleaner fix is a `canonicalAddress()` export from ./address.ts, which would
 * also let the grant prompt and the update subset-check compare canonical
 * forms -- filed as docs/open-questions.md A18, deliberately not done here
 * because address.ts belongs to another stream.
 * Found by review, 2026-08-27.
 */
function isCanonicalLiteral (value: string): boolean {
  if (value.includes(':')) {
    // No zone id: `fe80::1%eth0` names a local interface, is never
    // internet-reachable, and is not a thing a dialer should be handed.
    if (value.includes('%')) return false
    if (!/^[0-9a-f:.]+$/.test(value)) return false

    const gap = value.indexOf('::')
    if (gap !== value.lastIndexOf('::')) return false

    const head = gap === -1 ? value : value.slice(0, gap)
    const tail = gap === -1 ? '' : value.slice(gap + 2)
    const headGroups = head.length > 0 ? head.split(':') : []
    const tailGroups = tail.length > 0 ? tail.split(':') : []
    const groups = [...headGroups, ...tailGroups]
    if (groups.includes('')) return false

    let words = 0
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i] ?? ''
      if (group.includes('.')) {
        // A dotted quad is legal only as the very last group of the literal.
        if (i !== groups.length - 1) return false
        if (!isCanonicalIpv4(group)) return false
        words += 2
        continue
      }
      // Lower case only, and no leading zeros: RFC 5952's presentation form,
      // which is what every resolver and `net.isIP` round-trip produces.
      if (!/^(0|[1-9a-f][0-9a-f]{0,3})$/.test(group)) return false
      words += 1
    }

    return gap === -1 ? words === 8 : words <= 7
  }

  return isCanonicalIpv4(value)
}

/** A strict dotted quad: four decimal octets, no leading zeros, no short forms. */
function isCanonicalIpv4 (value: string): boolean {
  const parts = value.split('.')
  if (parts.length !== 4) return false
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return false
    if (Number.parseInt(part, 10) > 0xff) return false
  }
  return true
}

/** True only for a port an outbound connection can actually name. */
function isValidPort (port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= MAX_PORT
}

interface ParsedPattern {
  readonly host: string
  readonly port: string
}

/**
 * Splits a `host:port` pattern. Returns null for anything it does not
 * recognise, and a null pattern matches nothing -- so an unreadable pattern
 * removes authority rather than granting it.
 *
 * IPv6 hosts must be BRACKETED (`[::1]:443`). Unbracketed, `::1:443` is
 * genuinely ambiguous -- it is also a valid address on its own -- and a parser
 * that guesses is a parser that can be made to guess wrong. Rejecting costs an
 * app author one pair of brackets; guessing costs the user a socket to
 * somewhere they did not agree to.
 */
function parsePattern (pattern: Pattern): ParsedPattern | null {
  if (typeof pattern !== 'string') return null

  const text = pattern.trim()
  if (text.length === 0 || text.length > MAX_PATTERN_LENGTH) return null
  if (!isAsciiHost(text)) return null

  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    if (end === -1) return null
    const rest = text.slice(end + 1)
    if (!rest.startsWith(':')) return null
    const host = text.slice(1, end)
    const port = rest.slice(1)
    return host.length > 0 && port.length > 0 ? { host, port } : null
  }

  const split = text.lastIndexOf(':')
  if (split === -1) return null // a bare port range is a listen pattern, not a connect one
  const host = text.slice(0, split)
  const port = text.slice(split + 1)
  if (host.length === 0 || port.length === 0) return null
  if (host.includes(':')) return null // unbracketed IPv6

  return { host, port }
}

/**
 * `*`, a single port, or an inclusive `lo-hi` range.
 *
 * NO PRIVILEGED-PORT RULE HERE, deliberately. Ports below 1024 are denied
 * outright for `listen` and `bind` (capability-api.md A9 SS1) because those
 * open a service; applying the same rule to `connect` would deny 80 and 443
 * and break every outbound connection an app makes. Two different decisions
 * that happen to mention the same number.
 */
function portMatches (spec: string, port: number): boolean {
  if (spec === '*') return true

  // Leading zeros rejected: `0443` reads as octal in some parsers and decimal
  // in others, and a pattern whose meaning depends on the reader is not a
  // pattern. Port 0 is rejected by the `[1-9]` lead -- it means "any free
  // port" to bind() and nothing at all to connect().
  const parsed = /^([1-9][0-9]{0,4})(?:-([1-9][0-9]{0,4}))?$/.exec(spec)
  if (parsed === null) return false

  const loText = parsed[1]
  if (loText === undefined) return false
  const lo = Number.parseInt(loText, 10)
  const hi = parsed[2] === undefined ? lo : Number.parseInt(parsed[2], 10)

  if (lo > MAX_PORT || hi > MAX_PORT || lo > hi) return false
  return port >= lo && port <= hi
}

/**
 * Decides whether one pattern's host part authorises `address`.
 *
 * `requested` is the normalised name the app asked for. It is a SECONDARY
 * bound, never the primary one: a hostname pattern additionally requires the
 * resolved address to be public unicast, so matching the name can only ever
 * narrow what `address` already permitted.
 */
function hostMatches (spec: string, requested: string, address: string): boolean {
  // `*` means PUBLIC UNICAST ONLY -- specified, not inferred, because the
  // flagship genuinely declares `*:*` and an app holding it must still not
  // reach the user's router, NAS or 169.254.169.254 (security-model.md T12,
  // capability-api.md).
  if (spec === '*') return isPublicUnicast(address)

  const host = normalizeHost(spec)

  if (classifyAddress(host) !== 'unparseable') {
    // An address literal in the manifest is an EXPLICIT declaration of that
    // address, and it is the only way a private range becomes reachable: the
    // user was shown it and granted it. Compared against the resolved address,
    // so `nas.internal` -> 192.168.1.50 is allowed under a `192.168.1.50:5000`
    // declaration while `evil.example` -> 127.0.0.1 is not.
    //
    // It must be written CANONICALLY. `2130706433:22` is 127.0.0.1:22 spelled
    // as an opaque number, and the "the user was shown it and granted it"
    // justification above is worth exactly as much as the rendering is
    // legible. Rejecting here, rather than falling through to the hostname
    // branch, is load-bearing -- see isCanonicalLiteral.
    if (!isCanonicalLiteral(host)) return false

    // Compared as STRINGS, both sides canonical, because address.ts exposes
    // no canonicaliser and re-implementing a parser here would put two
    // different notions of "what an address is" in the same codebase -- the
    // precise disagreement that lets the check and the connect point at
    // different hosts. A mismatch DENIES, so the failure direction is safe.
    return host === address
  }

  // Anything left is a hostname declaration.

  // No sub-glob support: `*.example.com` matches nothing rather than being
  // approximated. A wildcard that silently spans a registry boundary
  // (`*.co.uk`) grants far more than its author read it as, and an app author
  // finds a denial in seconds while a user never finds an over-grant at all.
  if (host.includes('*')) return false

  // A hostname NEVER authorises a private address, even its own. That is not
  // an oversight: "the name resolved there" is the whole of the rebinding
  // attack, so a name cannot be the evidence that the range was intended.
  // Reaching a LAN host requires declaring its address literally, above.
  return host === requested && isPublicUnicast(address)
}

/**
 * Host AND port must come from THE SAME pattern.
 *
 * The tempting wrong shape is `patterns.some(hostOk) && patterns.some(portOk)`,
 * which reads identically and grants the cross product: a manifest declaring
 * `["a.example:443", "b.example:8080"]` would authorise `a.example:8080`,
 * which the user granted for neither host. It passed the entire suite before
 * ./connect.test.ts grew a test for it. Found by review, 2026-08-27.
 */
function patternAuthorises (
  parsed: ParsedPattern | null,
  requested: string,
  address: string,
  port: number
): boolean {
  if (parsed === null) return false
  if (!portMatches(parsed.port, port)) return false
  return hostMatches(parsed.host, requested, address)
}

/**
 * True if any declared pattern could authorise this host and port, whatever
 * the name turns out to resolve to. Uses only what is knowable WITHOUT an
 * address, so it can run before the lookup.
 *
 * WHY IT RUNS BEFORE THE RESOLVER. Without it, a manifest declaring nothing
 * but `["api.example.com:443"]` still causes the user's machine to resolve any
 * name the app names, at any port, indefinitely: unrestricted DNS reach that
 * no manifest bounds and no grant authorises, usable as a covert channel and
 * as a de-anonymising one (security-model.md T20). Worse, resolving first
 * makes the two failure paths distinguishable -- a name that does not exist
 * throws out of `resolveFn`, a name that does returns a denial -- which is a
 * clean existence oracle over arbitrary names, and precisely the LAN mapping
 * the uniform denial exists to prevent. Found by review, 2026-08-27.
 *
 * DELIBERATELY WEAK, and it must stay that way. It answers "could this
 * possibly be allowed", never "is this allowed": a `*` pattern or an
 * address-literal pattern makes it true for every name, because
 * `nas.internal -> 192.168.1.50` is a case the literal branch must still be
 * allowed to reach. Every real decision stays below, after the addresses are
 * in hand.
 */
function couldAnyPatternMatch (
  parsed: ReadonlyArray<ParsedPattern | null>,
  requested: string,
  port: number
): boolean {
  for (const pattern of parsed) {
    if (pattern === null) continue
    if (!portMatches(pattern.port, port)) continue
    if (pattern.host === '*') return true

    const host = normalizeHost(pattern.host)
    // An address-literal pattern can be reached by a name that resolves to it,
    // so it cannot be ruled out from the name alone.
    if (classifyAddress(host) !== 'unparseable') return true
    if (host === requested) return true
  }
  return false
}

/**
 * Decides whether `manifest` authorises an outbound TCP connection to
 * `hostArg`:`port`, resolving through the injected `resolveFn`.
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
  manifest: Manifest,
  hostArg: string,
  port: number,
  resolveFn: Resolver
): Promise<ConnectDecision> {
  // The manifest arrives as JSON off the network, so it is untrusted shape as
  // well as untrusted content -- hence the optional chaining on fields the
  // type says are required. Absence means absence, never default-allow
  // (capability-api.md design rules 4 and 5).
  const declared = manifest?.capabilities?.net?.tcp?.connect
  const patterns: readonly Pattern[] = Array.isArray(declared) ? declared : []
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
    // more strings than ./address.ts parses. See isCanonicalLiteral.
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
