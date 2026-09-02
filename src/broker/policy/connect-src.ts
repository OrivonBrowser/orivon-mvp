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
//      case. A worker script served the same way inherits ITS OWN response's
//      CSP, not the document's -- if this gap is real, a worker's `fetch`
//      bypasses T22 entirely, silently.
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
// WIDER than the grant costs the user the grant they refused; that is the
// only one of the two directions that is a security bug.
//
// BEING NARROWER IS NOT FREE, THOUGH -- say so plainly, because the emitted
// list is the app's ENTIRE `connect-src` allowlist. An omitted pattern is
// not "uncovered by CSP"; it is BLOCKED. The flagship torrent app holds
// `tcp.connect: ["*:*"]` (capability-api.md), which has no CSP equivalent
// (below) and is therefore omitted outright -- once build step 4 wires this
// header in, that app's ordinary `fetch`/WebSocket calls get
// `connect-src 'self'` and nothing else, even though the broker itself
// would allow any public address reached through `orivon.net.connect`.
// Owner decision, 2026-09-02 (open-questions.md A43): the header stays this
// strict rather than widening to CSP's bare `*` -- widening is the bigger
// bug (see "HOST: `*` HAS NO CSP EQUIVALENT" below). `omitted`, on
// `ConnectSrcPolicy`, is what lets a later trust screen tell a user WHY a
// feature broke instead of leaving it silent -- every unrepresentable
// pattern is reported there, on every return path this file has.
//
// HOST: AN IPv6 LITERAL HAS NO CSP EQUIVALENT EITHER. CSP's host-source
// grammar is `host-char = ALPHA / DIGIT / "-"` (w3c/webappsec-csp) --
// brackets and colons are not in it, and Chromium enforces this: a source
// list containing `[::1]:443` logs "contains an invalid source... It will
// be ignored" and the source is dropped outright, never partially honoured
// (confirmed in Electron 44.0.0 / Chrome 152, 2026-09-02, alongside IPv4
// literals -- both loopback and LAN -- being accepted and enforced
// correctly). An earlier version of this file re-bracketed IPv6 literals
// and emitted them; that was wrong twice over -- the token was invalid CSP,
// so it never widened anything, but `omitted` stayed empty for it, which
// means the file was CLAIMING coverage a grant did not actually have.
// `host-ipv6-literal` (below) exists to keep that claim honest.
//
// THE HONEST LIMIT, stated rather than hidden: CSP bounds NAMES; checkConnect
// (./connect.ts) bounds RESOLVED ADDRESSES. For a hostname pattern the two
// diverge exactly on DNS rebinding (security-model.md T12) -- a name this
// grants CSP reach to can still resolve privately, reachable by `fetch`
// though not by `orivon.net.connect`. No CSP construction closes that; it is
// Chromium's Private Network Access problem, not this function's. What T22
// actually closes is narrower than ADR-0006's own wording claims: this
// bounds `fetch`/WebSocket, nothing else. `img-src`, `form-action`,
// `script-src`, `frame-src`, navigation and `<link rel=prefetch>` remain
// open channels -- filed as open-questions.md A42.
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
// depth. `hostToken` also bounds every host to `MAX_HOST_LENGTH` -- the same
// bound `checkConnect` enforces, not `connect-patterns.ts`'s wider
// `MAX_PATTERN_LENGTH` (300, sized for a host plus a port range). Without
// that bound a 254-298 character host would pass the charset allowlist and
// be emitted here while `checkConnect` denies the identical host with
// `bad-host` -- the one place this file would have been WIDER than the
// broker's own check.

import type { Pattern } from '../../contracts/index.js'
import { MAX_HOST_LENGTH, normalizeHost } from './canonical-host.js'
import { type HostSpecKind, hostSpecKind, parsePattern, parsePortSpec } from './connect-patterns.js'
import { MAX_PATTERNS } from './connect.js'

export type ConnectSrcOmissionReason =
  /** `granted` was not an array -- a corrupted grant store, never an app author's mistake. Names the whole grant, not one pattern. */
  | 'bad-grant'
  /** More than `MAX_PATTERNS` granted. Whole grant -- mirrors checkConnect's own too-many-patterns denial. */
  | 'too-many-patterns'
  /** Not a `host:port` pattern: unsplittable, empty, over-length, non-ASCII, or unbracketed IPv6. */
  | 'bad-pattern'
  /** The host authorises nothing anyway -- a sub-glob, or a non-canonical address literal. */
  | 'host-authorises-nothing'
  /** `*`. CSP's bare `*` would also permit loopback and the LAN, which a `*` grant explicitly does not. */
  | 'host-any-public-unicast'
  /** An IPv6 literal. CSP's host grammar has no `[`, `]` or `:` in it -- Chromium drops the source. */
  | 'host-ipv6-literal'
  /** The host is over `MAX_HOST_LENGTH`, or otherwise fails the output allowlist. */
  | 'bad-host'
  /** The port part is not `*`, a single port, or an inclusive `lo-hi` range. */
  | 'bad-port'
  /** A port range wider than `MAX_ENUMERATED_PORTS`. Same rule as `*`: unenumerable is unrepresentable. */
  | 'port-range-too-wide'
  /** `MAX_CONNECT_SRC_SOURCES` reached. This pattern, and every pattern after it in grant order. */
  | 'over-budget'

export interface OmittedPattern {
  /** Absent only for a whole-grant reason (`bad-grant`, `too-many-patterns`) that names no single pattern. */
  readonly pattern?: Pattern
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
   * `orivon.net.connect` is" -- and, for an app like the flagship, "CSP
   * cannot cover this grant at all". Non-empty `omitted` means the emitted
   * `sources` are STRICTER than the grant; nothing further reports how much.
   */
  readonly omitted: readonly OmittedPattern[]
}

// AI-RECOMMENDED, NOT AN OWNER DECISION. Sized against: the flagship's
// realistic range is 6881-6889 (nine ports); MAX_PATTERNS is 256, so an
// unbounded enumeration is 256 x 65535 tokens. Neither number is specified
// anywhere in the corpus.
const MAX_ENUMERATED_PORTS = 16
// Counts `'self'` -- the real ceiling on GRANTED sources is 127, not 128.
const MAX_CONNECT_SRC_SOURCES = 128

const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/
const IPV4_RE = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/

/**
 * The host half of an emitted source, or `null` if it fails the allowlist.
 * `kind` is already narrowed to the two shapes that ever reach here --
 * `'any-public-unicast'` and `'authorises-nothing'` are filtered out by the
 * caller, and an address literal containing a colon is filtered out too
 * (`host-ipv6-literal`, see this file's header), so an address literal
 * reaching this function is always IPv4.
 */
function hostToken (normalizedHost: string, kind: Exclude<HostSpecKind, 'any-public-unicast' | 'authorises-nothing'>): string | null {
  if (normalizedHost.length > MAX_HOST_LENGTH) return null
  if (kind === 'address-literal') return IPV4_RE.test(normalizedHost) ? normalizedHost : null
  return HOSTNAME_RE.test(normalizedHost) ? normalizedHost : null
}

/**
 * The `:port` tokens a spec expands to, or the reason it cannot -- the
 * reason itself, not a sentinel, so the caller cannot map it to the wrong
 * `ConnectSrcOmissionReason`. Always at least one token on success:
 * `parsePortSpec` guarantees `lo <= hi`.
 */
function portTokens (portSpec: string): readonly string[] | 'bad-port' | 'port-range-too-wide' {
  const parsed = parsePortSpec(portSpec)
  if (parsed === null) return 'bad-port'
  if (parsed === 'any') return ['*']

  const count = parsed.hi - parsed.lo + 1
  if (count > MAX_ENUMERATED_PORTS) return 'port-range-too-wide'

  const tokens: string[] = []
  for (let port = parsed.lo; port <= parsed.hi; port++) tokens.push(String(port))
  return tokens
}

type Translated =
  | { readonly pattern: Pattern, readonly tokens: readonly string[] }
  | { readonly pattern: Pattern, readonly reason: ConnectSrcOmissionReason }

/**
 * One pattern to its `host:port` source tokens, or the reason it has none.
 * No budget logic here -- every pattern is translated in full, even past
 * where the budget will later cut off, so a malformed pattern past the cap
 * still reports `bad-port`/`bad-host` rather than a misleading
 * `over-budget` that hides the real mistake from its author.
 */
function translate (pattern: Pattern): Translated {
  const parsed = parsePattern(pattern)
  if (parsed === null) return { pattern, reason: 'bad-pattern' }

  const kind = hostSpecKind(parsed.host)
  if (kind === 'authorises-nothing') return { pattern, reason: 'host-authorises-nothing' }
  if (kind === 'any-public-unicast') return { pattern, reason: 'host-any-public-unicast' }

  const normalized = normalizeHost(parsed.host)
  // Gated on `kind`, not a bare `.includes(':')`: a bracketed spec that is
  // NOT valid IPv6 (`[a:b:c]:443`, say) classifies as 'hostname', not
  // 'address-literal' -- it must fall through to hostToken's HOSTNAME_RE
  // and report `bad-host`, not be mislabelled as an IPv6 literal it isn't.
  if (kind === 'address-literal' && normalized.includes(':')) {
    return { pattern, reason: 'host-ipv6-literal' }
  }

  const host = hostToken(normalized, kind)
  if (host === null) return { pattern, reason: 'bad-host' }

  const ports = portTokens(parsed.port)
  if (typeof ports === 'string') return { pattern, reason: ports }

  return { pattern, tokens: ports.map((port) => `${host}:${port}`) }
}

/** The host half of an already-assembled `host:port` token. */
function hostOf (token: string): string {
  return token.slice(0, token.lastIndexOf(':'))
}

/**
 * Walks the grant in order, admitting each pattern's tokens all-or-nothing
 * once budget allows. A token already emitted by an EARLIER pattern -- or
 * already covered by an earlier pattern's `host:*` -- costs nothing, so a
 * pattern can be fully represented even when none of its own tokens are
 * new. That is the only direction dropping a token is sound in: dropping
 * one in favour of a LATER pattern's token would let that later pattern's
 * own rejection (budget, or anything else) silently erase an earlier
 * grant's authority -- exactly the trap a REDUCE-before-BUDGET phase falls
 * into, which is why there is no such phase.
 *
 * Once one pattern does not fit, every pattern after it in grant order is
 * `over-budget` too -- even a pattern that would itself cost nothing. That
 * is a deliberate, documented over-report: the alternative -- still
 * checking cost for patterns past the cutoff, and admitting the zero-cost
 * ones -- makes the emitted set depend on which patterns happen to be free
 * rather than on grant order, breaking the prefix property this function's
 * callers (and the "appending a pattern cannot evict an earlier one" test)
 * rely on.
 */
function emit (translated: readonly Translated[]): ConnectSrcPolicy {
  const sources: string[] = ["'self'"]
  const emittedTokens = new Set<string>(sources)
  const wildcardHosts = new Set<string>()
  const omitted: OmittedPattern[] = []
  let full = false

  for (const t of translated) {
    if ('reason' in t) {
      omitted.push({ pattern: t.pattern, reason: t.reason })
      continue
    }
    if (full) {
      omitted.push({ pattern: t.pattern, reason: 'over-budget' })
      continue
    }

    const newTokens = t.tokens.filter((token) => {
      if (emittedTokens.has(token)) return false
      return !wildcardHosts.has(hostOf(token))
    })

    if (sources.length + newTokens.length > MAX_CONNECT_SRC_SOURCES) {
      omitted.push({ pattern: t.pattern, reason: 'over-budget' })
      full = true
      continue
    }

    for (const token of newTokens) {
      emittedTokens.add(token)
      sources.push(token)
      if (token.endsWith(':*')) wildcardHosts.add(hostOf(token))
    }
  }

  return { sources, omitted }
}

/**
 * The CSP `connect-src` value for one origin's granted `tcp.connect`
 * patterns. `'self'` is always first and always present, even with an
 * empty grant -- an app must be able to fetch its own cached bundle
 * (ADR-0007: the bundle is served AT the app's own origin, inside its own
 * partition).
 */
export function connectSrcFor (granted: readonly Pattern[]): ConnectSrcPolicy {
  if (!Array.isArray(granted)) {
    return { sources: ["'self'"], omitted: [{ reason: 'bad-grant' }] }
  }
  // Mirrors checkConnect's own too-many-patterns denial (connect.ts). One
  // omitted entry for the whole grant, not one per pattern -- a grant this
  // size is already meaningless, and enumerating it here would be the same
  // unbounded-work bug MAX_PATTERNS exists to prevent, one function over.
  if (granted.length > MAX_PATTERNS) {
    return { sources: ["'self'"], omitted: [{ reason: 'too-many-patterns' }] }
  }

  return emit(granted.map(translate))
}

/** `"connect-src 'self' api.example.com:443"` -- the header VALUE, nothing else. */
export function appCspHeaderValue (granted: readonly Pattern[]): string {
  return `connect-src ${connectSrcFor(granted).sources.join(' ')}`
}
