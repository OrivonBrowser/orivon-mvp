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
// Flagged rather than solved because the signature is fixed by
// docs/development/testing.md SS1. Narrowing the list at the call site is the
// cheaper of the two and keeps this function single-purpose.
//
// SCOPE. `tcp.connect` only. `udp.send` has the same pattern rules
// (manifest.ts) and can reuse everything here when udp is wired. `tcp.listen`
// and `udp.bind` are a DIFFERENT decision -- bare port ranges, `"*"` rejected,
// privileged ports denied outright -- and get their own function rather than a
// mode flag on this one, because the two share a grammar and nothing else.

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
 */
export type Resolver = (host: string) => Promise<readonly string[]>

export interface ConnectAllowed {
  readonly allowed: true
  /**
   * The addresses to dial, normalised and already validated.
   *
   * DIAL THESE, never `hostArg`. This is the second half of the T12
   * mitigation and the reason the allow branch -- not the denial branch --
   * is the one carrying data: a broker physically cannot proceed without
   * destructuring this, so "resolve, check, then connect to the literal"
   * is enforced by the shape of the return value rather than by a comment
   * somebody has to remember to read.
   */
  readonly addresses: readonly string[]
}

export interface ConnectDenied {
  readonly allowed: false
  /**
   * Always 'denied', never anything else, and never accompanied by a reason.
   *
   * Typed through OrivonErrorCode so that renaming the code in
   * ../../contracts/errors.ts breaks this build instead of silently leaving
   * the broker emitting a string no app switches on.
   */
  readonly code: Extract<OrivonErrorCode, 'denied'>
}

export type ConnectDecision = ConnectAllowed | ConnectDenied

/**
 * EVERY denial is this exact object.
 *
 * Uniform by design (../../contracts/errors.ts): if denials varied by reason,
 * an app could iterate -- vary the port, vary the host, watch which reason
 * comes back -- and map exactly which pattern, port and address class is
 * blocked, turning the permission boundary itself into a probe target. It
 * would learn the shape of the user's LAN without ever completing a
 * connection.
 *
 * Sharing one frozen instance makes that structural rather than a convention:
 * there is no per-call object to attach a reason to, and a future edit that
 * wants one has to change the type, which changes the tests.
 *
 * The broker's own DENIAL LOG is a separate channel that never reaches the
 * app, and it has everything it needs to write a useful line without help
 * from here -- `classifyAddress` (./address.ts) names the range.
 */
const DENIED: ConnectDenied = Object.freeze({ allowed: false, code: 'denied' })

const MAX_PORT = 65535

/** RFC 1035's limit on a presentation-format domain name. */
const MAX_HOST_LENGTH = 253

/** A host at the limit, a colon, and the widest port range. */
const MAX_PATTERN_LENGTH = 300

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
    // Compared as STRINGS, both sides normalised, because address.ts exposes
    // no parser and re-implementing one here would put two different notions
    // of "what an address is" in the same codebase -- the precise disagreement
    // that lets the check and the connect point at different hosts. The cost:
    // a pattern must be written the way a resolver writes it (`::1`, not
    // `0:0:0:0:0:0:0:1`). A mismatch DENIES, so the failure direction is safe.
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

function patternAuthorises (
  pattern: Pattern,
  requested: string,
  address: string,
  port: number
): boolean {
  const parsed = parsePattern(pattern)
  if (parsed === null) return false
  if (!portMatches(parsed.port, port)) return false
  return hostMatches(parsed.host, requested, address)
}

/**
 * Decides whether `manifest` authorises an outbound TCP connection to
 * `hostArg`:`port`, resolving through the injected `resolveFn`.
 *
 * Resolves once, requires EVERY returned address to pass, and returns the
 * validated literals for the caller to dial. One bad answer denies the whole
 * connection -- a host that answers 93.184.216.34 and 127.0.0.1 is a host
 * mounting the attack, and Node 24's `autoSelectFamily: true` means the
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
  if (patterns.length === 0) return DENIED

  if (typeof hostArg !== 'string') return DENIED
  if (!isValidPort(port)) return DENIED

  const requested = normalizeHost(hostArg)
  if (requested.length === 0 || requested.length > MAX_HOST_LENGTH) return DENIED

  // An address literal is already the thing patterns are matched against, so
  // there is nothing to resolve -- and not calling out means not depending on
  // how a resolver treats a literal. It is still checked identically below;
  // the shortcut skips the lookup, never the policy.
  const isLiteral = classifyAddress(requested) !== 'unparseable'
  const answers = isLiteral ? [requested] : await resolveFn(requested)

  // Fail closed on an empty answer. `[].every(...)` is TRUE, and a check built
  // on it would wave through exactly the host whose nameserver returned
  // nothing.
  if (answers.length === 0) return DENIED

  const addresses: string[] = []
  for (const answer of answers) {
    if (typeof answer !== 'string') return DENIED

    const address = normalizeHost(answer)

    // Every answer must be an address literal. The caller dials what this
    // function returns, so a name in here would be resolved a second time at
    // connect(), which is the rebinding window reopened one layer down.
    //
    // REDUNDANT TODAY, AND KEPT DELIBERATELY. Every branch below already
    // rejects an unparseable answer: `*` and the hostname branch go through
    // isPublicUnicast, which is false for anything it cannot parse
    // (./address.ts), and the literal branch compares strings, so a parseable
    // pattern host can only equal a parseable address. Removing this line
    // therefore breaks no test -- it is the one mutation ./connect.test.ts
    // does not catch, recorded there rather than papered over.
    //
    // It stays because it is the only line that makes "what this function
    // returns is dialable" a local property. Without it the guarantee is
    // inherited from a documented behaviour of another module, and the cost
    // of that inheritance turning out to be wrong is a socket opened to a
    // name instead of an address.
    if (classifyAddress(address) === 'unparseable') return DENIED

    if (!patterns.some((pattern) => patternAuthorises(pattern, requested, address, port))) {
      return DENIED
    }

    addresses.push(address)
  }

  return { allowed: true, addresses }
}
