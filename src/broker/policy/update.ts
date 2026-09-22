// The update decision table. Pure function, no I/O -- see ./README.md.
// One question: an app the user has already granted has published a new
// bundle and/or manifest -- does it install silently, must the user be
// asked, or is it refused outright? Re-consent is a SUBSET CHECK over the
// granted PATTERN set, never a comparison of capability KINDS -- see
// widensAuthority below, and README.md's Design notes for why.

import type { CapabilityKind, Grant, Pattern } from '../../contracts/index.js'
import { canonicalAddress, classifyAddress } from './address.js'
import { isArray, ownProperty } from './own-property.js'
import { compareVersions } from './version-order.js'

export { compareVersions } from './version-order.js'

/**
 * What the broker does with the update.
 *
 * Ordered by severity: `capability-prompt` > `reconsent` > `silent`. A
 * below-floor version needs `rollback-choice` until acknowledged for this
 * origin; after that it re-enters the same hierarchy, with `rollback-notice`
 * standing in for `silent` -- never a shortcut past `capability-prompt`/
 * `reconsent` (README.md, Design notes).
 *
 * - `silent`             nothing the user consented to has changed.
 * - `reconsent`          same authority, different code (ADR-0005: the hash
 *                        pin breaking IS the signal).
 * - `capability-prompt`  the manifest asks for authority beyond the granted
 *                        pattern set -- subsumes `reconsent`: granting new
 *                        authority re-establishes consent for the app as it
 *                        now is.
 * - `rollback-choice`    below this origin's version floor, never yet
 *                        acknowledged -- the user is warned and chooses
 *                        (README.md, Design notes).
 * - `rollback-notice`    below floor, already acknowledged, and this
 *                        offering wants nothing an ordinary update wouldn't
 *                        also get `silent` for -- installs, with a passive,
 *                        non-blocking notice instead of a prompt.
 */
export type UpdateDecision = 'silent' | 'reconsent' | 'capability-prompt' | 'rollback-choice' | 'rollback-notice'

/**
 * A pattern set keyed by capability kind -- the collapsed form of the origin's
 * `Grant[]` (see `Grant` in contracts/manifest.ts, which is keyed on
 * `(origin, capability, pattern set)` for precisely this comparison).
 *
 * A kind PRESENT with an empty array means "this capability, which carries no
 * patterns" -- `fs` and `id` are granted that way. That is a different thing
 * from a kind being ABSENT, which means not granted / not requested. The
 * distinction is load-bearing: `{ id: [] }` appearing where granted has no
 * `id` key at all is a brand-new capability and must prompt.
 */
export type PatternSet = Readonly<Partial<Record<CapabilityKind, readonly Pattern[]>>>

/**
 * The ledger's actual `Grant[]` (`broker.app.grants(origin)`), collapsed into
 * the `PatternSet` shape `decideUpdate` and T22's CSP derivation both take --
 * never the manifest's declared set (index.ts's own `connect()` precedent,
 * A18). Last-write-wins per key is safe here, not a shortcut: `GrantLedger`
 * holds at most one live grant per capability kind per origin (`grant()`
 * replaces, it never appends), so two entries for one kind cannot occur in a
 * `Grant[]` this function is ever actually given.
 */
export function patternSetFromGrants (grants: readonly Grant[]): PatternSet {
  const result: { [K in CapabilityKind]?: readonly Pattern[] } = {}
  for (const grant of grants) result[grant.capability] = grant.patterns
  return result
}

/**
 * Order-independent set equality -- two patterns are the same authority
 * however a manifest or a persisted record happens to list them, so
 * re-declaring them in a different order is never mistaken for a change.
 *
 * NOT `widensAuthority` above: that is a one-directional COVERS check under
 * the runtime's matching grammar (`*:*` "covers" `93.184.216.34:443` without
 * being equal to it), the right question for "may this update proceed
 * silently". This is a stricter, symmetric "is this the exact same
 * authority" check -- the right question for "may an id naming that
 * authority be reused" (grant-persistence.ts's `replaceHydratedGrants`,
 * A168) or "is a re-grant even necessary" (main/grant-changed-
 * capabilities.ts). Moved here from that second, original caller once a
 * third call site needed the identical idea (code-guidelines.md Rule 3) --
 * `src/main/` may import from here, but `src/broker/` must never import
 * from `src/main/`, so the shared copy has to live on this side.
 */
export function sameOwnPatterns (a: readonly Pattern[], b: readonly Pattern[]): boolean {
  if (a.length !== b.length) return false
  const left = [...a].sort()
  const right = [...b].sort()
  return left.every((pattern, index) => pattern === right[index])
}

export interface UpdateInput {
  /** Bundle hash the user consented to, from the grant ledger (TOFU, ADR-0005). */
  readonly pinnedHash: string
  /** Bundle hash just computed over the fetched tree. */
  readonly newHash: string
  /** What the user actually granted. */
  readonly grantedPatterns: PatternSet
  /** What the new manifest declares it wants. */
  readonly newPatterns: PatternSet
  /** `Manifest.version` of the incoming bundle. */
  readonly version: string
  /**
   * The highest version ever installed for this origin. Not the currently
   * installed version -- a floor that moves down with a downgrade defeats its
   * own purpose (T19).
   */
  readonly versionFloor: string
  /**
   * Whether the user has already chosen, at least once, to proceed with a
   * below-floor version from this origin (2026-09-04 owner decision). Ignored
   * entirely unless `version` is actually below `versionFloor` -- it must
   * never, on its own, turn an ordinary at-or-above-floor update into a
   * notice.
   *
   * CALLER CONTRACT: a bare per-origin flag is only safe because
   * `ordinaryEscalation` still runs before it's trusted (fixed 2026-09-05) --
   * an unparseable `version` fails closed into this SAME below-floor branch
   * as a real rollback (`isAtOrAboveFloor`), so a "this origin had SOME
   * rollback approved once" boolean would let a garbage version string ride a
   * prior, unrelated approval. The `rollback-ack` persistence lane (A61)
   * stores the acknowledged VERSION itself for exactly this reason -- derive
   * this field by comparing the offered `version` against that, so an
   * unparseable or different version naturally computes `false`.
   */
  readonly rollbackAcknowledged: boolean
  /**
   * What the currently pinned manifest declared: authority the person was
   * already asked about, whatever they answered (granted, declined, or
   * since revoked). Optional; absent means "unknown" and changes nothing.
   *
   * Counted as covered by the widening check, so the SAME question is not
   * asked again on every visit. That never grants anything -- a declined
   * capability stays ungranted -- and a genuinely new request, anything
   * outside BOTH this set and `grantedPatterns`, still prompts.
   */
  readonly previouslyDeclaredPatterns?: PatternSet | undefined
}

/** Per-kind union of two pattern sets, for the widening check's "already asked about" side. */
function unionPatterns (a: PatternSet, b: PatternSet | undefined): PatternSet {
  if (b === undefined) return a
  const out: { [K in CapabilityKind]?: readonly Pattern[] } = { ...a }
  for (const kind of Object.keys(b) as CapabilityKind[]) {
    const extra = patternsFor(b, kind)
    if (extra !== undefined) out[kind] = [...(patternsFor(a, kind) ?? []), ...extra]
  }
  return out
}

/**
 * What a same-or-higher-version update would require for this authority/
 * bundle change, if either check fires -- `null` means neither does
 * (`silent` territory).
 *
 * Pulled out so `decideUpdate` has exactly one place running the widening/
 * bundle-change checks, called from both its at-or-above-floor path and its
 * acknowledged-rollback path below -- fixing the 2026-09-05 defect where an
 * acknowledged rollback skipped both and fell straight to the silently-
 * installing `rollback-notice`. Sharing one function makes "a rollback is
 * never LESS scrutinised than an ordinary update with the same change" true
 * by construction, not by two call sites happening to agree.
 */
function ordinaryEscalation (update: UpdateInput): 'capability-prompt' | 'reconsent' | null {
  // A SUBSET CHECK, not a kind comparison -- see widensAuthority below, and
  // ./README.md's Design notes for why a kind comparison misses a `*:*` widening.
  if (widensAuthority(unionPatterns(update.grantedPatterns, update.previouslyDeclaredPatterns), update.newPatterns)) return 'capability-prompt'

  // Deliberately checked AFTER the pattern check and not folded into it.
  // Since ADR-0009 the manifest is a hashed LEAF, so a manifest-only change
  // already moves the bundle hash -- but the ordering stays regardless: a
  // widened pattern set must produce 'capability-prompt', never the weaker
  // 'reconsent', and folding the checks together would let whichever ran
  // first decide. The severity order is the rule; the hash is not a
  // short-circuit for it.
  if (!isSameBundle(update.pinnedHash, update.newHash)) return 'reconsent'

  return null
}

export function decideUpdate (update: UpdateInput): UpdateDecision {
  // The floor is checked FIRST, because a replayed old bundle is
  // indistinguishable from a legitimate one at every other level: it
  // hash-pins validly (it really is code this publisher shipped), and its
  // pattern set is by construction one the user already accepted. If this
  // check ran after the others, an attacker with control of the host could
  // suppress a security fix indefinitely and the user would only ever see a
  // "the code changed" prompt (security-model.md T19).
  if (!isAtOrAboveFloor(update.version, update.versionFloor)) {
    if (!update.rollbackAcknowledged) return 'rollback-choice'

    // ADR-0013: acknowledging a rollback settles only the rollback question
    // -- it is a fact about the origin, not a blank cheque for whatever that
    // origin serves under an already-forgiven version number. See
    // ordinaryEscalation's own comment.
    return ordinaryEscalation(update) ?? 'rollback-notice'
  }

  return ordinaryEscalation(update) ?? 'silent'
}

// --- version floor -----------------------------------------------------------

/**
 * FAILS CLOSED. An unorderable version pair is treated as below the floor and
 * rejected, because "we cannot prove this is not a replayed older bundle" and
 * "this is a replayed older bundle" must lead to the same outcome -- otherwise
 * the floor is bypassed by publishing a version string the parser cannot read.
 *
 * OPEN DECISION, flagged rather than assumed: this rejects an app whose
 * `version` is not semver-shaped (e.g. `"2026-08-26"`), loudly and at update
 * time. The alternative -- installing what we cannot order -- reopens T19, so
 * strictness wins here, but the manifest validator should reject unorderable
 * versions at FIRST install so a publisher finds out immediately instead of on
 * their first update.
 */
function isAtOrAboveFloor (version: string, floor: string): boolean {
  const order = compareVersions(version, floor)
  // Equal to the floor is fine: re-fetching the installed version is the
  // ordinary no-op case, not a rollback.
  return order !== null && order >= 0
}

// --- the subset check --------------------------------------------------------

/**
 * True if `requested` asks for anything outside `granted`.
 *
 * Note the direction, because reversing it is the single most damaging
 * one-character bug available in this file: every REQUESTED pattern must be
 * covered by some GRANTED pattern. `granted ⊇ requested`. The reverse test
 * ("is every granted pattern still requested") passes happily for
 * `["api.example.com:443"] -> ["*:*"]`.
 *
 * EXPORTED as of 2026-09-10 (P4-1): ./request-grant.ts's decideGrantRequest
 * reuses this exact function as its subset check -- "declared" standing in
 * for `granted` -- rather than writing a second copy of the one idea this
 * file's own header calls out (docs/development/code-guidelines.md Rule 3).
 */
export function widensAuthority (granted: PatternSet, requested: PatternSet): boolean {
  // Iterating the REQUESTED keys rather than a hardcoded list of capability
  // kinds means a kind added to contracts/manifest.ts later is checked here
  // with no edit, and an unrecognised kind arriving from a parsed manifest is
  // treated as ungranted rather than skipped.
  for (const kind of Object.keys(requested) as readonly CapabilityKind[]) {
    const wanted = patternsFor(requested, kind)
    if (wanted === undefined) continue

    const held = patternsFor(granted, kind)
    // A capability KIND that was never granted. This branch is real and
    // necessary -- but it is NOT sufficient on its own, which is the whole
    // correction recorded in capability-api.md A9 SS2.
    if (held === undefined) return true

    for (const pattern of wanted) {
      if (!held.some((grantedPattern) => covers(grantedPattern, pattern))) return true
    }
  }

  return false
}

/**
 * Own-property read with an array check (./own-property.ts). Both halves
 * matter for input that came from a publisher-controlled JSON document: a
 * `__proto__` key would otherwise resolve through the prototype chain to a
 * non-array, and a non-array value would throw on `.some(...)` -- a crash
 * inside the function whose job is to decide whether to prompt.
 *
 * The cast trusts the element shape the same way the type PatternSet already
 * does -- ownProperty's array guard confirms the value is AN array, not that
 * every element is a well-formed Pattern; nothing here validated that before
 * either.
 */
function patternsFor (set: PatternSet, kind: CapabilityKind): readonly Pattern[] | undefined {
  return ownProperty(set, kind, isArray) as readonly Pattern[] | undefined
}

// --- pattern coverage --------------------------------------------------------

interface PortRange {
  readonly lo: number
  readonly hi: number
}

type ParsedPattern =
  | { readonly shape: 'host-port'; readonly host: string; readonly ports: PortRange }
  | { readonly shape: 'ports'; readonly ports: PortRange }

/**
 * True if everything `requested` authorises is already authorised by
 * `granted`.
 *
 * DELIBERATELY CONSERVATIVE, and it must stay that way. Under-approximating
 * coverage costs a prompt the user did not strictly need; over-approximating
 * it silently hands over authority. Anything this function does not
 * positively understand -- a shape it cannot parse, a host form it does not
 * recognise, a granted/requested shape mismatch -- is NOT covered.
 *
 * This is not the runtime capability matcher. That one answers "may this app
 * reach this RESOLVED ADDRESS" and must resolve DNS first (T12); this one
 * answers "is this pattern set contained in that pattern set" and touches no
 * network at all. Do not merge them.
 */
function covers (granted: Pattern, requested: Pattern): boolean {
  // web.context's own patterns (ADR-0019; manifest.ts's own doc: "compared
  // exactly") are whole `https://host[:port]` origin strings -- a shape
  // this file's host:port/port-range grammar was never built for, and
  // parsing one through it anyway is unreliable rather than merely wrong:
  // an origin naming a NON-DEFAULT port happens to parse as a (nonsensical)
  // host:port pattern via parsePattern's own last-colon split, while one at
  // the default port (the common case -- the canonical origin form omits
  // it) does not parse at all, so whether a match was found would silently
  // depend on that accident rather than on a real subset relation. Checked
  // first and only for this one recognisable shape -- nothing else in
  // contracts/manifest.ts's pattern grammars ever starts with a scheme --
  // so it never reaches the connect grammar below at all. Exact string
  // equality is the correct (and only) "covers" relation for a pattern kind
  // with none of host:port's own subset structure.
  if (granted.startsWith('https://') || requested.startsWith('https://')) return granted === requested

  const from = parsePattern(granted)
  const to = parsePattern(requested)
  if (from === null || to === null) return false

  if (from.shape === 'host-port') {
    if (to.shape !== 'host-port') return false
    if (!hostCovers(from.host, to.host)) return false
  } else if (to.shape !== 'ports') {
    return false
  }

  return from.ports.lo <= to.ports.lo && to.ports.hi <= from.ports.hi
}

/**
 * `host:port` (`*:*`, `api.example.com:443`, `[::1]:443`) or a bare port range
 * (`6881-6889`, `6881`, `*`) -- the two forms in contracts/manifest.ts.
 */
function parsePattern (raw: string): ParsedPattern | null {
  const text = raw.trim().toLowerCase()
  if (text.length === 0) return null

  // Split at the LAST colon so a bracketed IPv6 literal keeps its own colons.
  const at = text.lastIndexOf(':')
  if (at === -1) {
    const ports = parsePorts(text)
    return ports === null ? null : { shape: 'ports', ports }
  }

  const host = text.slice(0, at)
  const ports = parsePorts(text.slice(at + 1))
  if (host.length === 0 || ports === null) return null
  return { shape: 'host-port', host, ports }
}

function parsePorts (text: string): PortRange | null {
  if (text === '*') return { lo: 0, hi: 65535 }

  const at = text.indexOf('-')
  if (at === -1) {
    const port = parsePort(text)
    return port === null ? null : { lo: port, hi: port }
  }

  const lo = parsePort(text.slice(0, at))
  const hi = parsePort(text.slice(at + 1))
  if (lo === null || hi === null || lo > hi) return null
  return { lo, hi }
}

// Leading zeros rejected: `0443` reads as octal in some parsers and decimal
// in others, and a pattern whose meaning depends on the reader is not a
// pattern. Port 0 is rejected by the `[1-9]` lead -- it means "any free port"
// to bind() and nothing at all to connect(). Aligned with the identical
// reasoning in ./connect.ts's portMatches (2026-08-27) -- the two grammars
// had drifted, so a manifest could declare a port pattern this subset check
// accepted but the runtime connect matcher could never honour.
function parsePort (text: string): number | null {
  if (!/^[1-9][0-9]{0,4}$/.test(text)) return null
  const value = Number(text)
  return value <= 65535 ? value : null
}

/**
 * True if `granted` already authorises every host `requested` would.
 *
 * NO SUFFIX-WILDCARD BRANCH, deliberately. This file used to treat a leading
 * `*.` as a real suffix wildcard here -- `*.example.com` covering
 * `api.example.com` -- while `connect-patterns.ts`'s `hostSpecKind` already
 * treats ANY host containing `*` beyond a bare `*` as authorising NOTHING at
 * connect time (docs/open-questions.md A27: the two files disagreed about
 * this). A granted `*.example.com` therefore authorises no host at all, so
 * any REAL host `requested` names is WIDER than that, not narrower --
 * treating it as a real suffix match here silently skipped re-consent for an
 * app moving from an inert pattern to one that actually works. An unchanged
 * `*.example.com` pattern still reads as covered, via the exact-string check
 * below; only a pattern that would actually widen falls through to a prompt.
 */
function hostCovers (granted: string, requested: string): boolean {
  if (granted === '*') return true

  // Both sides an address literal: compare canonically, so two spellings of
  // ONE address (`127.0.0.1` / `2130706433`) read as identical authority
  // rather than a widening needing re-consent for nothing that actually
  // changed (docs/open-questions.md A20). Never applies across an
  // address/hostname mismatch -- a hostname is never treated as if it might
  // secretly be the same as some address literal.
  if (classifyAddress(granted) !== 'unparseable' && classifyAddress(requested) !== 'unparseable') {
    return canonicalAddress(granted) === canonicalAddress(requested)
  }

  return granted === requested
}

// --- bundle pin --------------------------------------------------------------

/**
 * Hex digest comparison, normalised for case and whitespace only. Normalising
 * can merge two spellings of the SAME digest but can never merge two different
 * digests, so it cannot turn a changed bundle into an unchanged one.
 *
 * A blank digest on either side counts as CHANGED. An empty `newHash` means
 * the tree hash could not be computed, and "we do not know what this code is"
 * must never resolve to `silent`.
 */
function isSameBundle (pinnedHash: string, newHash: string): boolean {
  const pinned = pinnedHash.trim().toLowerCase()
  const fetched = newHash.trim().toLowerCase()
  if (pinned.length === 0 || fetched.length === 0) return false
  return pinned === fetched
}
