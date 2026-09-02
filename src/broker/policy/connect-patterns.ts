// The connect pattern grammar and matching, split out of ./connect.ts
// (docs/development/code-guidelines.md Rule 2).
//
// SCOPE, from ./connect.ts's own header: `tcp.connect` only, but `udp.send`
// has the same pattern rules (../../contracts/manifest.ts) and can reuse
// every function here -- including `checkConnect` itself now that it takes
// the granted pattern list directly rather than reading `net.tcp.connect` by
// name off a Manifest (docs/open-questions.md A18). Not wired up for
// `udp.send` here; that is new scope. `tcp.listen` and `udp.bind` are a
// DIFFERENT decision (bare port ranges, `"*"` rejected, privileged ports
// denied outright) and get their own function, because the two share a
// grammar and nothing else.

import type { Pattern } from '../../contracts/index.js'
import { canonicalAddress, classifyAddress, isPublicUnicast } from './address.js'
import { MAX_PORT, isAsciiHost, normalizeHost } from './canonical-host.js'

/** A host at the limit, a colon, and the widest port range. */
const MAX_PATTERN_LENGTH = 300

export interface ParsedPattern {
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
export function parsePattern (pattern: Pattern): ParsedPattern | null {
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
export function portMatches (spec: string, port: number): boolean {
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
 * Which of the four shapes a pattern's host part is -- extracted so a second
 * consumer (../policy/connect-src.ts's CSP `connect-src` derivation) can
 * classify a host spec the SAME way `hostMatches` decides it, instead of
 * writing a second classifier that can drift from this one. That drift is
 * not hypothetical: docs/open-questions.md A27 is exactly `update.ts` and
 * this file once disagreeing about what a leading `*.` means.
 *
 * `'never'` covers two different reasons a spec authorises nothing --
 * a non-canonical address literal (`2130706433`, `0177.0.0.1`) and a
 * sub-glob (`*.example.com`) -- collapsed into one answer because both are
 * unconditional: unlike `'hostname'`, whether they match depends on nothing
 * else you could pass in.
 */
export type HostSpecKind = 'any-public-unicast' | 'address-literal' | 'hostname' | 'never'

export function hostSpecKind (spec: string): HostSpecKind {
  // `*` means PUBLIC UNICAST ONLY -- specified, not inferred, because the
  // flagship genuinely declares `*:*` and an app holding it must still not
  // reach the user's router, NAS or 169.254.169.254 (security-model.md T12,
  // capability-api.md).
  if (spec === '*') return 'any-public-unicast'

  const host = normalizeHost(spec)

  if (classifyAddress(host) !== 'unparseable') {
    // It must be written CANONICALLY. `2130706433:22` is 127.0.0.1:22 spelled
    // as an opaque number, and the "the user was shown it and granted it"
    // justification an address literal otherwise earns is worth exactly as
    // much as the rendering is legible. canonicalAddress NORMALISES rather
    // than rejecting (docs/open-questions.md A20), so this compares the
    // result to the input, not just checking it parsed -- exactly what the
    // deleted `isCanonicalLiteral(host)` used to mean.
    return canonicalAddress(host) === host ? 'address-literal' : 'never'
  }

  // No sub-glob support: `*.example.com` matches nothing rather than being
  // approximated. A wildcard that silently spans a registry boundary
  // (`*.co.uk`) grants far more than its author read it as, and an app author
  // finds a denial in seconds while a user never finds an over-grant at all.
  if (host.includes('*')) return 'never'

  return 'hostname'
}

/**
 * Decides whether one pattern's host part authorises `address`.
 *
 * `requested` is the normalised name the app asked for. It is a SECONDARY
 * bound, never the primary one: a hostname pattern additionally requires the
 * resolved address to be public unicast, so matching the name can only ever
 * narrow what `address` already permitted.
 */
export function hostMatches (spec: string, requested: string, address: string): boolean {
  const host = normalizeHost(spec)

  switch (hostSpecKind(spec)) {
    case 'any-public-unicast':
      return isPublicUnicast(address)
    case 'never':
      return false
    case 'address-literal':
      // An address literal in the manifest is an EXPLICIT declaration of that
      // address, and it is the only way a private range becomes reachable:
      // the user was shown it and granted it. Compared against the resolved
      // address, so `nas.internal` -> 192.168.1.50 is allowed under a
      // `192.168.1.50:5000` declaration while `evil.example` -> 127.0.0.1 is
      // not.
      //
      // Compared as STRINGS, both sides already canonical (hostSpecKind's own
      // check, and ./connect.ts's own canonicalAddress(...) === address
      // invariant on every resolved answer), so there is only one spelling of
      // each to compare -- never two different notions of "what an address
      // is" that could point the check and the connect at different hosts. A
      // mismatch DENIES, so the failure direction is safe.
      return host === address
    case 'hostname':
      // A hostname NEVER authorises a private address, even its own. That is
      // not an oversight: "the name resolved there" is the whole of the
      // rebinding attack, so a name cannot be the evidence that the range was
      // intended. Reaching a LAN host requires declaring its address
      // literally, above.
      return host === requested && isPublicUnicast(address)
  }
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
export function patternAuthorises (
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
 * allowed to reach. Every real decision stays in ./connect.ts, after the
 * addresses are in hand.
 */
export function couldAnyPatternMatch (
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
