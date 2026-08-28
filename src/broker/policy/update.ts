// The update decision table. Pure function, no I/O -- see ./README.md.
//
// One question: an app the user has already granted has published a new
// bundle and/or a new manifest. Does it install silently, must the user be
// asked, or is it refused outright?
//
// THE RULE THIS FILE EXISTS FOR (capability-api.md open item A9 SS2, corrected
// 2026-08-25; security-model.md T19; ADR-0005 SSAmendment 2026-08-25 evening):
// the re-consent trigger is a SUBSET CHECK OVER THE GRANTED PATTERN SET, never
// a comparison of capability KINDS. An update changing
// `connect: ["api.example.com:443"]` to `connect: ["*:*"]` requests no new
// capability kind at all. Under a kind comparison it installs SILENTLY, and a
// user who granted "talk to one host" is now running an app that may "connect
// to any computer on the internet" -- the exact grant journey 1 puts on
// camera.
//
// Its failure mode is "no prompt appeared", which no manual checklist catches
// (docs/development/testing.md SS5). ./update.test.ts is the only thing between
// that rule and a silent regression, which is why that file mutation-tests
// itself against three deliberately-wrong implementations.

import type { CapabilityKind, Pattern } from '../../contracts/index.js'

/**
 * What the broker does with the update.
 *
 * These are ordered by severity -- `reject` > `capability-prompt` >
 * `reconsent` > `silent` -- and `decideUpdate` returns the most severe one
 * that applies:
 *
 * - `silent`        install it; nothing the user consented to has changed.
 * - `reconsent`     "this app's code changed" (ADR-0005: hash-pinning is the
 *                   only integrity mechanism in v0, so the pin breaking IS the
 *                   signal). Same authority, different bytes.
 * - `capability-prompt`  the manifest asks for authority beyond the granted
 *                   pattern set. Strictly more serious than `reconsent`, and
 *                   it subsumes it: granting new authority necessarily
 *                   re-establishes consent for the app as it now is, whereas
 *                   re-consenting to changed code says nothing about new
 *                   authority.
 * - `reject`        do not install at any prompt. Reserved for the version
 *                   floor, where the correct answer is not "ask the user" --
 *                   a replayed old bundle looks identical to a legitimate one
 *                   and no prompt can tell the user which they are looking at.
 */
export type UpdateDecision = 'silent' | 'reconsent' | 'capability-prompt' | 'reject'

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
}

export function decideUpdate (update: UpdateInput): UpdateDecision {
  // The floor is checked FIRST and outranks everything, because a replayed
  // old bundle is indistinguishable from a legitimate one at every other
  // level: it hash-pins validly (it really is code this publisher shipped),
  // and its pattern set is by construction one the user already accepted. If
  // this check ran after the others, an attacker with control of the host
  // could suppress a security fix indefinitely and the user would only ever
  // see a "the code changed" prompt (security-model.md T19).
  if (!isAtOrAboveFloor(update.version, update.versionFloor)) return 'reject'

  // A SUBSET CHECK, not a kind comparison. See the file header -- this single
  // line is the reason this module exists.
  if (widensAuthority(update.grantedPatterns, update.newPatterns)) return 'capability-prompt'

  // Deliberately checked AFTER the pattern check and not folded into it.
  //
  // CORRECTED 2026-08-27. This previously read "the manifest is served
  // separately from the bundle (/.well-known/orivon.json), so a host can widen
  // the manifest while serving byte-identical code" -- true when written, false
  // since ADR-0009: the manifest is a hashed LEAF, so a manifest-only change
  // does move the bundle hash. The ordering is unaffected and stays for a
  // stronger reason: a widened pattern set must produce 'capability-prompt',
  // never the weaker 'reconsent', and folding the checks together would let
  // whichever ran first decide. The severity order is the rule; the hash is
  // not a short-circuit for it.
  if (!isSameBundle(update.pinnedHash, update.newHash)) return 'reconsent'

  return 'silent'
}

// --- version floor -----------------------------------------------------------

/**
 * Semver ordering: `-1` if `a` sorts before `b`, `0` if equal, `1` if after,
 * and **`null` when the two cannot be ordered at all** -- a non-numeric
 * release component (`1.x.0`), an empty or non-semver prerelease identifier.
 *
 * Exported because the broker must ALSO compute the new floor after a
 * successful install (`max(floor, version)`). A second, divergent comparator
 * written at that call site is exactly how a floor decays into decoration.
 *
 * Build metadata (`+sha.abc`) is stripped and ignored, per semver: it is
 * explicitly not part of the ordering, so `1.2.3+a` and `1.2.3+b` are the same
 * version and neither is a rollback of the other.
 */
export function compareVersions (a: string, b: string): number | null {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return null

  const width = Math.max(left.release.length, right.release.length)
  for (let i = 0; i < width; i += 1) {
    // Missing trailing components are zero, so `1.2` and `1.2.0` compare equal
    // rather than being unorderable.
    const diff = (left.release[i] ?? 0) - (right.release[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }

  return comparePrerelease(left.prerelease, right.prerelease)
}

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

interface ParsedVersion {
  readonly release: readonly number[]
  readonly prerelease: readonly string[]
}

const RELEASE_COMPONENT = /^[0-9]{1,9}$/
const PRERELEASE_IDENTIFIER = /^[0-9A-Za-z-]+$/

function parseVersion (raw: string): ParsedVersion | null {
  const text = raw.trim()
  if (text.length === 0) return null

  const withoutBuild = splitOnce(text, '+')[0]
  const [core, prereleaseText] = splitOnce(withoutBuild, '-')

  const components = core.split('.')
  // Bounded to 9 digits so a component stays an exact integer and a hostile
  // version string cannot exploit float rounding to compare equal to the
  // floor.
  if (!components.every((component) => RELEASE_COMPONENT.test(component))) return null
  const release = components.map((component) => Number(component))

  if (prereleaseText === undefined) return { release, prerelease: [] }
  const prerelease = prereleaseText.split('.')
  if (!prerelease.every((identifier) => PRERELEASE_IDENTIFIER.test(identifier))) return null
  return { release, prerelease }
}

/** Semver SS11.3-11.4: a prerelease sorts BELOW its release, numeric identifiers below alphanumeric. */
function comparePrerelease (a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1

  const width = Math.max(a.length, b.length)
  for (let i = 0; i < width; i += 1) {
    const left = a[i]
    const right = b[i]
    // A shorter run of identifiers sorts lower when the shared prefix is equal.
    if (left === undefined) return -1
    if (right === undefined) return 1

    const leftIsNumeric = RELEASE_COMPONENT.test(left)
    const rightIsNumeric = RELEASE_COMPONENT.test(right)
    if (leftIsNumeric && rightIsNumeric) {
      const diff = Number(left) - Number(right)
      if (diff !== 0) return diff < 0 ? -1 : 1
      continue
    }
    if (leftIsNumeric !== rightIsNumeric) return leftIsNumeric ? -1 : 1
    if (left !== right) return left < right ? -1 : 1
  }

  return 0
}

function splitOnce (text: string, separator: string): [string, string | undefined] {
  const at = text.indexOf(separator)
  if (at === -1) return [text, undefined]
  return [text.slice(0, at), text.slice(at + separator.length)]
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
 */
function widensAuthority (granted: PatternSet, requested: PatternSet): boolean {
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
 * Own-property read with an array check. Both halves matter for input that
 * came from a publisher-controlled JSON document: a `__proto__` key would
 * otherwise resolve through the prototype chain to a non-array, and a
 * non-array value would throw on `.some(...)` -- a crash inside the function
 * whose job is to decide whether to prompt.
 */
function patternsFor (set: PatternSet, kind: CapabilityKind): readonly Pattern[] | undefined {
  if (!Object.hasOwn(set, kind)) return undefined
  const patterns = set[kind]
  return Array.isArray(patterns) ? patterns : undefined
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

function hostCovers (granted: string, requested: string): boolean {
  if (granted === '*') return true
  if (granted === requested) return true

  // `*.example.com` covers `api.example.com` and also `*.eu.example.com`,
  // because every host the latter admits is one the former already admits.
  // It does NOT cover the apex `example.com` (no dot) nor `evilexample.com`
  // (the leading dot in the suffix is what stops the classic suffix-match
  // bug), and nothing but `*` covers a bare `*`.
  if (granted.startsWith('*.')) {
    const suffix = granted.slice(1)
    const tail = requested.startsWith('*.') ? requested.slice(1) : requested
    return tail.length > suffix.length && tail.endsWith(suffix)
  }

  return false
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
