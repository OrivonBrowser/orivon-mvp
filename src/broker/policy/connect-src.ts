// T22's CSP `connect-src` derivation (security-model.md, ADR-0006), pure and
// side-effect-free -- computes the header VALUE only. Actually calling
// `session.webRequest.onHeadersReceived` with it is build step 4's job, the
// same "pure value now, wiring deferred" pattern as the rest of build step
// 2. Four things whoever wires it needs to know, recorded here because
// nothing else in the corpus does:
//
//   1. ADD this header to the response, never REPLACE the existing ones --
//      multiple CSP headers are enforced as an intersection, which is what
//      makes T22's "the app cannot relax it" true without stripping
//      anything the app's own document sent.
//   2. VERIFY WHETHER `onHeadersReceived` FIRES FOR `protocol.handle`-SERVED
//      RESPONSES AT ALL. ADR-0007 serves the cached bundle through
//      `session.fromPartition(...).protocol.handle('https', ...)`, and
//      nothing in the corpus confirms `webRequest` sees those responses --
//      set the header on the protocol handler's own `Response` too, just in
//      case.
//   3. It is per-partition, per-origin, and must be recomputed whenever a
//      grant changes.
//   4. A live `context7` check is required before writing the actual
//      Electron wiring (`onHeadersReceived`, `protocol.handle`,
//      `fromPartition` all qualify, per CLAUDE.md's tooling table).
//
// THE SECURITY INVARIANT: every emitted source names a (host, port) pair a
// SINGLE granted pattern names LITERALLY. Nothing here generalises a
// pattern -- no port wildcard standing in for a range, no `*` standing in
// for public-unicast, no subdomain wildcard, no invented scheme. Being
// NARROWER than the grant costs the app a `fetch` call; being WIDER costs
// the user the grant they refused. Only one of those is a security bug.
//
// THE HONEST LIMIT, stated rather than hidden: CSP bounds NAMES; checkConnect
// (./connect.ts) bounds RESOLVED ADDRESSES. For a hostname pattern the two
// diverge exactly on DNS rebinding (security-model.md T12) -- a name this
// grants CSP reach to can still resolve privately, reachable by `fetch`
// though not by `orivon.net.connect`. No CSP construction closes that; it is
// Chromium's Private Network Access problem, not this function's. What T22
// actually closes is narrower than ADR-0006's own wording claims: this
// bounds `fetch`/WebSocket, nothing else. `img-src`, `form-action`,
// navigation and `<link rel=prefetch>` remain open channels -- filed as
// open-questions.md A42.
//
// DERIVES FROM THE GRANTED PATTERNS, NEVER THE MANIFEST'S DECLARED ONES.
// T22's own wording says "manifest-declared hosts", which predates A18's
// resolution -- ./index.ts's own connect() already establishes the
// precedent this file follows: "nothing below ever reads
// manifest.capabilities.net.tcp.connect, which is what the app DECLARED and
// may be far wider." Using the manifest here would let CSP permit reach the
// user explicitly refused.
//
// WHY EVERY OUTPUT TOKEN IS RE-VALIDATED, INDEPENDENT OF THE TRANSLATION
// RULES BELOW: `isAsciiHost` (./canonical-host.ts) permits any printable
// ASCII, including space and `;`. A pattern host containing either, emitted
// verbatim, either reads as TWO CSP sources (a space splits a source list)
// or terminates the directive early and injects a second one (a `;` closes
// it). The allowlist regexes below are the only thing standing between a
// user-granted host and a CSP-injection bug -- mandatory, not defence in
// depth.

import type { Pattern } from '../../contracts/index.js'
import { normalizeHost } from './canonical-host.js'
import { hostSpecKind, parsePattern, parsePortSpec } from './connect-patterns.js'
import { MAX_PATTERNS } from './connect.js'

export type ConnectSrcOmissionReason =
  | 'unparseable'
  | 'not-authorising'
  | 'any-host'
  | 'port-not-enumerable'
  | 'not-representable'
  | 'budget'

export interface OmittedPattern {
  readonly pattern: Pattern
  readonly reason: ConnectSrcOmissionReason
}

export interface ConnectSrcPolicy {
  /** Always begins with `'self'`; never empty. */
  readonly sources: readonly string[]
  /**
   * Every granted pattern with no safe CSP representation, and why --
   * reported rather than silently dropped, the same reason `checkConnect`
   * returns a closed `ConnectDenialReason` union instead of a bare boolean.
   * The grant prompt / trust indicator (later build steps) need to be able
   * to say "`fetch` to this host is not covered by CSP even though
   * `orivon.net.connect` is".
   */
  readonly omitted: readonly OmittedPattern[]
}

// AI-RECOMMENDED, NOT AN OWNER DECISION. Sized against: the flagship's
// realistic range is 6881-6889 (nine ports); MAX_PATTERNS is 256, so an
// unbounded enumeration is 256 x 65535 tokens. Neither number is specified
// anywhere in the corpus.
const MAX_ENUMERATED_PORTS = 16
const MAX_CONNECT_SRC_SOURCES = 128

const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/
const IPV4_RE = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/
const IPV6_TOKEN_RE = /^\[[0-9a-f:.]+\]$/
const PORT_TOKEN_RE = /^(?:\*|[1-9][0-9]{0,4})$/

/**
 * The host half of an emitted source, or `null` if it fails the allowlist.
 * `kind` is already narrowed to the two shapes that ever reach here --
 * `'any-public-unicast'` and `'never'` are filtered out by the caller before
 * this runs.
 */
function hostToken (normalizedHost: string, kind: 'address-literal' | 'hostname'): string | null {
  if (kind === 'address-literal') {
    // parsePattern strips IPv6 brackets internally, so an address literal
    // containing a colon must be RE-bracketed -- the unbracketed form is the
    // exact ambiguous shape parsePattern itself rejects as a pattern.
    if (normalizedHost.includes(':')) {
      const bracketed = `[${normalizedHost}]`
      return IPV6_TOKEN_RE.test(bracketed) ? bracketed : null
    }
    return IPV4_RE.test(normalizedHost) ? normalizedHost : null
  }
  return HOSTNAME_RE.test(normalizedHost) ? normalizedHost : null
}

function portTokens (portSpec: string): { readonly tokens: readonly string[] } | { readonly omit: true } | null {
  const parsed = parsePortSpec(portSpec)
  if (parsed === null) return null
  if (parsed === 'any') return { tokens: ['*'] }

  const count = parsed.hi - parsed.lo + 1
  if (count > MAX_ENUMERATED_PORTS) return { omit: true }

  const tokens: string[] = []
  for (let port = parsed.lo; port <= parsed.hi; port++) tokens.push(String(port))
  return { tokens }
}

/**
 * The CSP `connect-src` value for one origin's granted `tcp.connect`
 * patterns. `'self'` is always first and always present, even with an
 * empty grant -- an app must be able to fetch its own cached bundle
 * (ADR-0007: the bundle is served AT the app's own origin, inside its own
 * partition).
 */
export function connectSrcFor (granted: readonly Pattern[]): ConnectSrcPolicy {
  // Mirrors checkConnect's own not-declared/too-many-patterns denial: an
  // invalid grant shape authorises nothing beyond the app's own assets.
  if (!Array.isArray(granted) || granted.length > MAX_PATTERNS) {
    return { sources: ["'self'"], omitted: [] }
  }

  const sources: string[] = ["'self'"]
  const seen = new Set<string>(sources)
  const omitted: OmittedPattern[] = []

  for (const pattern of granted) {
    const parsed = parsePattern(pattern)
    if (parsed === null) {
      omitted.push({ pattern, reason: 'unparseable' })
      continue
    }

    const kind = hostSpecKind(parsed.host)
    if (kind === 'never') {
      omitted.push({ pattern, reason: 'not-authorising' })
      continue
    }
    if (kind === 'any-public-unicast') {
      // No CSP primitive for "any public unicast address" exists. CSP's
      // bare `*` would also permit loopback and the LAN, which a `*` grant
      // explicitly does not authorise (connect-patterns.ts's own
      // hostMatches). Not representable at all, not even approximately.
      omitted.push({ pattern, reason: 'any-host' })
      continue
    }

    const host = hostToken(normalizeHost(parsed.host), kind)
    if (host === null) {
      omitted.push({ pattern, reason: 'not-representable' })
      continue
    }

    const ports = portTokens(parsed.port)
    if (ports === null) {
      omitted.push({ pattern, reason: 'unparseable' })
      continue
    }
    if ('omit' in ports) {
      omitted.push({ pattern, reason: 'port-not-enumerable' })
      continue
    }

    if (sources.length + ports.tokens.length > MAX_CONNECT_SRC_SOURCES) {
      omitted.push({ pattern, reason: 'budget' })
      continue
    }

    for (const port of ports.tokens) {
      if (!PORT_TOKEN_RE.test(port)) continue // unreachable given parsePortSpec's own grammar; defence in depth
      const candidate = `${host}:${port}`
      if (seen.has(candidate)) continue
      seen.add(candidate)
      sources.push(candidate)
    }
  }

  return { sources, omitted }
}

/** `"connect-src 'self' api.example.com:443"` -- the header VALUE, nothing else. */
export function appCspHeaderValue (granted: readonly Pattern[]): string {
  return `connect-src ${connectSrcFor(granted).sources.join(' ')}`
}
