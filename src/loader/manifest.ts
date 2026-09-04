// Manifest parsing and validation -- pure, no I/O, no fetching, no caching.
// Transcribed from docs/architecture/capability-api.md SSManifest, which is
// the specification. This is deliberately narrower than "the app loader":
// fetch, hash-pinning and the update decision (src/broker/policy/update.ts)
// depend on broker storage that does not exist yet (src/loader/README.md).
//
// THE INPUT IS ADVERSARIAL. Any origin can serve a manifest at
// /.well-known/orivon.json, and `id`/`name` are self-asserted
// (contracts/manifest.ts). A validator that COERCES a wrong shape into
// something plausible is how a manifest ends up meaning something the
// publisher did not write -- every check below REJECTS, never repairs, the
// same stance src/broker/policy/pin.ts and canonical-path.ts already take on
// untrusted JSON.
//
// Rejections are DEVELOPER-FACING, unlike a capability denial
// (contracts/errors.ts's uniform 'denied' -- varying that would turn a
// permission boundary into a probe target). This is not a security boundary,
// so precision is the goal, not uniformity: every reason names the exact
// field and exactly what was wrong with it.
//
// The `capabilities` sub-tree (net/fs/id/protocols and the pattern grammars
// they are built from) lives in ./manifest-capabilities.ts -- split out so
// this file stays under the 500-line limit (code-guidelines.md Rule 2) once
// the PR-29 review's five findings were fixed. Several helpers below
// (reject, describeValue, isRecord, isAny, extraKey, optionalStringArray,
// UNSAFE_TEXT_CHARS) are exported for that file's use, not for any consumer
// outside this directory.

import type { Manifest } from '../contracts/index.js'
import { MAX_BUNDLE_ENTRIES, collisionKey, isValidCanonicalPath } from '../broker/policy/canonical-path.js'
import { ownProperty } from '../broker/policy/own-property.js'
import { compareVersions } from '../broker/policy/update.js'
import { readCapabilities } from './manifest-capabilities.js'

export interface ManifestOk {
  readonly ok: true
  readonly manifest: Manifest
}

export interface ManifestRejected {
  readonly ok: false
  /** Precise and developer-facing -- see the file header. Never shown to an end user as-is. */
  readonly reason: string
}

export type ManifestResult = ManifestOk | ManifestRejected

/**
 * Parses and validates a manifest. `input` may be the raw JSON text fetched
 * from /.well-known/orivon.json, or an already-parsed value -- both untrusted
 * either way.
 *
 * THE BYTE BOUND ONLY COVERS THE STRING PATH (a known gap, not fixed here --
 * see this PR's body under "Decisions and open questions"). A caller that
 * parses JSON itself and passes the resulting object owns the size bound on
 * that path; nothing in this codebase does that yet.
 */
export function parseManifest (input: unknown): ManifestResult {
  try {
    const value = typeof input === 'string' ? parseJsonText(input) : input
    return { ok: true, manifest: readManifest(value) }
  } catch (error) {
    if (error instanceof ManifestInvalid) return { ok: false, reason: error.message }
    throw error // a bug in this file, not an untrusted-input outcome -- never swallowed
  }
}

// --- bounds --------------------------------------------------------------
//
// AI-chosen, not specified anywhere in the spec -- flagged rather than
// silently assumed (CLAUDE.md Rule 1). Generous for any real manifest;
// bounded so "absurd size" rejects before any of these fields are used for
// real work.
// Exported so fetch-bundle.ts can fail fast on a declared Content-Length
// before downloading a manifest response, rather than duplicating the
// number (Rule 3, docs/development/code-guidelines.md).
export const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_ID_LENGTH = 255
const MAX_NAME_LENGTH = 200
const MAX_VERSION_LENGTH = 256
const MAX_ENTRY_LENGTH = 1024

const MANIFEST_KEYS = ['orivonApiVersion', 'id', 'name', 'version', 'entry', 'assets', 'capabilities']

/**
 * Two slots are reserved off MAX_BUNDLE_ENTRIES, not one. fetch-bundle.ts
 * unions `entry` into the file list it derives from this manifest (ADR-0011's
 * own "the loader fetches the union of the two"), so that list's length is
 * `1 (entry) + assets.length` -- that is the first reservation. fetch-bundle.ts's
 * own check, `assetPaths.length + 1 > MAX_BUNDLE_ENTRIES`, reserves a SECOND
 * slot on top of that, for the manifest leaf (MANIFEST_PATH) it always
 * fetches and pushes onto `entries` before the asset loop even starts --
 * that leaf is never a member of the derived list itself. So the constraint
 * this file must enforce is `(1 + assets.length) + 1 <= MAX_BUNDLE_ENTRIES`,
 * i.e. `assets.length <= MAX_BUNDLE_ENTRIES - 2`. A cap of `- 1` here let a
 * manifest with exactly MAX_BUNDLE_ENTRIES - 1 assets pass parseManifest
 * while being permanently unfetchable -- fetch-bundle.ts would always reject
 * it once entry was unioned in, with a rejection reason that gave no hint
 * the manifest validator's own accepted range was the actual cause.
 */
const MAX_ASSETS = MAX_BUNDLE_ENTRIES - 2

// C0/C1 controls, bidi overrides and isolates (U+202A-U+202E, U+2066-U+2069),
// zero-width characters (U+200B-U+200D, U+2060-U+2064, U+FEFF) and the
// line/paragraph separators (U+2028/U+2029). Not just "control characters"
// any more -- renamed accordingly. A bidi override in `name` renders in the
// grant prompt as a different string than it compares as (T25's RLO
// filename-spoof trick); a zero-width character in `id` renders identically
// to another id while comparing unequal, defeating the T18 collision check.
// Exported for manifest-capabilities.ts's curve-name check.
export const UNSAFE_TEXT_CHARS = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/

/**
 * A high surrogate not followed by its low half, or a low surrogate not
 * preceded by its high half -- minor finding 8. An unpaired surrogate
 * encodes inconsistently across storage and display, a risk for the T18
 * collision-surfacing requirement this file's `id` checks already exist for
 * (finding 1): two ids that are "the same" at one layer and not at another.
 * `id` only, not `name` -- name is free-form display text where an unpaired
 * surrogate is merely a rendering glitch, not an identity collision risk.
 */
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

// --- internal control flow ------------------------------------------------
//
// A rejection unwinds through a thrown ManifestInvalid rather than threading
// a Result through every nested check -- it never escapes parseManifest's own
// try/catch above, so this is ordinary control flow, not an I/O effect.

class ManifestInvalid extends Error {}

/** Exported so manifest-capabilities.ts's checks unwind through the same try/catch. */
export function reject (reason: string): never {
  throw new ManifestInvalid(reason)
}

export function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A guard that always succeeds, so ownProperty (own-property.ts) can do a RAW read: undefined means "absent", never "present but rejected by a guard" -- JSON has no undefined value to collide with that. */
export function isAny (_value: unknown): _value is unknown {
  return true
}

/**
 * The first own key not in `allowed`, or null. Never recurses into a value --
 * that is what keeps "deeply nested junk" cheap to reject: a field's shape is
 * only ever inspected after its name is known to belong here.
 *
 * Object.keys, not a for-in loop, so only OWN enumerable keys are seen. That
 * is also what makes a `"__proto__"` or `"constructor"` key harmless here:
 * JSON.parse sets either as an ordinary own property, never the real
 * prototype slot, so Object.keys reports it like any other name and it is
 * rejected below for the mundane reason that it is not a recognised field.
 */
export function extraKey (value: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return key
  }
  return null
}

/** Renders an untrusted value for an error message without recursing into it. */
export function describeValue (value: unknown): string {
  if (typeof value === 'string') {
    const shown = value.length > 100 ? `${value.slice(0, 100)}...(${value.length} chars)` : value
    return JSON.stringify(shown)
  }
  if (value === undefined) return 'undefined'
  // JSON.stringify(NaN) and JSON.stringify(Infinity) both return the STRING
  // "null" -- checked before the general number/boolean/null branch below,
  // or a rejection reason for "must be a finite number" would tell the
  // developer the value was null when it was NaN or Infinity (finding 5).
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  if (Array.isArray(value)) return `an array of length ${value.length}`
  if (typeof value === 'object') return 'an object'
  return `a ${typeof value}`
}

function requireString (value: Record<string, unknown>, field: string, min: number, max: number): string {
  const raw = ownProperty(value, field, isAny)
  if (raw === undefined) reject(`${field} is required`)
  if (typeof raw !== 'string') reject(`${field} must be a string, got ${describeValue(raw)}`)
  if (raw.length < min || raw.length > max) {
    reject(`${field} must be ${min}-${max} characters, got ${raw.length}`)
  }
  return raw
}

/**
 * An optional array of validated strings, or undefined if the field is
 * absent. `validateOne` calls `reject` itself on a bad element, so it can
 * name the exact index and reason.
 *
 * `key` (the true own-property name, e.g. `"bind"`) and `path` (the dotted
 * display prefix, e.g. `"capabilities.net.udp"`) are DELIBERATELY SEPARATE
 * parameters, not one string reused for both -- `ownProperty` looks up an
 * object's actual key, which is never the dotted display path. Conflating
 * them once during development made every nested pattern field read back as
 * silently absent instead of validated: `Object.hasOwn(value,
 * "capabilities.net.udp.bind")` is false even when `value.bind` is present,
 * so the whole array was skipped rather than rejected. Caught by this file's
 * own test suite, not found by inspection -- kept as the reason these two
 * parameters must never be collapsed back into one.
 *
 * An EMPTY array is rejected rather than accepted as a no-op: two spellings
 * of "nothing declared" (omit the field / declare `[]`) is exactly the kind
 * of ambiguity canonical-path.ts and canonical-host.ts refuse elsewhere in
 * this codebase, and it is cheap to refuse here too.
 *
 * Exported for manifest-capabilities.ts's readTcp/readUdp/readCapabilities.
 */
export function optionalStringArray (
  value: Record<string, unknown>,
  path: string,
  key: string,
  max: number,
  validateOne: (item: string, index: number) => void
): readonly string[] | undefined {
  const field = path.length > 0 ? `${path}.${key}` : key
  const raw = ownProperty(value, key, isAny)
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) reject(`${field} must be an array, got ${describeValue(raw)}`)
  if (raw.length === 0) reject(`${field} must not be empty when present -- omit the field instead`)
  if (raw.length > max) reject(`${field} has ${raw.length} entries, more than the ${max} allowed`)

  const items: string[] = []
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i]
    if (typeof item !== 'string') reject(`${field}[${i}] must be a string, got ${describeValue(item)}`)
    validateOne(item, i)
    items.push(item)
  }
  return items
}

/**
 * Shared by `entry` and each element of `assets` (ADR-0011) -- both are a
 * path relative to the app root (e.g. `"index.html"`), never a canonical
 * `/`-rooted path, so both are validated by PREFIXING one and reusing
 * canonical-path.ts's isValidCanonicalPath, rather than a second
 * traversal/control-char checker (Rule 3). That catches `..`, NUL and
 * control bytes, encoded traversal, Windows-reserved names and trailing
 * dot/space -- everything T1/T10 care about.
 *
 * Full membership -- "does the bundle actually have a leaf at this path" --
 * is explicitly NOT this file's job: ADR-0009's amendment assigns that check
 * to the app loader's fetch step, which needs the fetched asset tree this
 * file never sees (see this file's header and the PR description).
 *
 * PERCENT-ENCODED FIRST (finding 3). isValidCanonicalPath is built to check
 * `URL.pathname` output, which is ALWAYS already percent-encoded -- but a
 * manifest author writes a plain filename. Feeding the raw text straight in
 * made `isValidCanonicalPath`'s own re-derivation check ("does re-deriving
 * this path from itself change it") fire on nothing more than an ordinary
 * space or accented character, rejecting `"my app.html"` with a message that
 * told the author their filename was dangerous rather than that it needed
 * encoding.
 *
 * encodeEntrySegment below is NOT `new URL('/' + entry, BASE).pathname` on
 * the whole string -- that was tried and rejected, because the URL parser
 * ALSO resolves dot-segments as part of building a pathname: it silently
 * turns `"../../../etc/passwd"` into `"/etc/passwd"`, which then reads as a
 * perfectly ordinary canonical path and passes, defeating the traversal
 * check entirely rather than tripping it. Encoding PER SEGMENT (split on the
 * real `/` characters already in `entry`, a `.`/`..` segment passed through
 * UNTOUCHED) keeps every dot-segment literally present, so
 * isValidCanonicalPath's own re-derivation and decode-and-recheck logic
 * still catches `..`, encoded traversal (`"..%2Fevil.html"`, which decodes
 * to a literal `..` segment) and Windows-reserved names exactly as before --
 * verified against all three in this file's test suite, not assumed.
 */
function validateRelativePath (field: string, path: string): void {
  if (path.startsWith('/')) {
    reject(`${field} must be a path relative to the app root, without a leading slash: ${describeValue(path)}`)
  }
  if (isAbsoluteUrl(path)) {
    reject(`${field} must not be an absolute URL or use a URL scheme: ${describeValue(path)}`)
  }
  const canonical = '/' + path.split('/').map(encodeEntrySegment).join('/')
  if (!isValidCanonicalPath(canonical)) {
    reject(`${field} is not a safe relative path: ${describeValue(path)}`)
  }
}

/**
 * Percent-encodes one path segment the way `URL.pathname` would encode it in
 * isolation -- but never joined through a base, so there is no adjacent `/`
 * for a `.` or `..` segment to resolve against. A literal `.` or `..`
 * segment is returned untouched rather than risk it disappearing into a
 * dot-segment resolution this function must never perform (see
 * validateEntry's comment). `encodeURIComponent` is not used here because it
 * ALSO escapes `%`, which would double-encode a percent-escape the author
 * already wrote on purpose (`"..%2Fevil.html"` would become
 * `"..%252Fevil.html"`, silently changing what the string decodes to and
 * hiding the traversal attempt from isValidCanonicalPath's decode step).
 */
function encodeEntrySegment (segment: string): string {
  if (segment === '.' || segment === '..') return segment
  return new URL('https://canonicalisation.invalid/' + segment).pathname.slice(1)
}

/** True if `text` parses as a URL on its own -- i.e. it names a scheme, not a bundle-relative path. */
function isAbsoluteUrl (text: string): boolean {
  try {
    new URL(text)
    return true
  } catch {
    return false
  }
}

/**
 * `assets` (ADR-0011), validated the same way `entry` is, plus two checks
 * `optionalStringArray` alone cannot do: no element may duplicate `entry`
 * itself (one file, one name for it in the manifest), and no two elements
 * may duplicate each other (`seen` tracks what validateOne has already
 * passed, since it runs once per element in array order).
 *
 * Compared via `collisionKey` (canonical-path.ts), never the raw string --
 * the same idiom bundle-hash.ts's `bundleTree()` and pin.ts already use for
 * this exact class of check (Rule 3), not a third reimplementation of it.
 * An exact-string comparison would let `["style.css", "STYLE.CSS"]` or a
 * percent-encoded duplicate of `entry` both validate as distinct, even
 * though they name the same file under percent-decoding/case/Unicode
 * folding -- `bundleTree()` independently re-rejects any such collision
 * before a file is ever written, so this was never live-exploitable, but a
 * validator whose own doc comment ("no two elements may duplicate each
 * other") reads as a complete guarantee should actually provide one.
 */
function readAssets (value: Record<string, unknown>, entry: string): readonly string[] | undefined {
  const seen = new Map<string, number>()
  const entryKey = collisionKey(entry)
  return optionalStringArray(value, '', 'assets', MAX_ASSETS, (item, index) => {
    validateRelativePath(`assets[${index}]`, item)
    const key = collisionKey(item)
    if (key === entryKey) reject(`assets[${index}] duplicates entry: ${describeValue(item)}`)
    const priorIndex = seen.get(key)
    if (priorIndex !== undefined) reject(`assets[${index}] duplicates assets[${priorIndex}]: ${describeValue(item)}`)
    seen.set(key, index)
  })
}

// --- top level ---------------------------------------------------------------

function readManifest (value: unknown): Manifest {
  if (!isRecord(value)) reject(`manifest must be a JSON object, got ${describeValue(value)}`)
  const extra = extraKey(value, MANIFEST_KEYS)
  if (extra !== null) reject(`manifest has an unrecognised field: ${describeValue(extra)}`)

  const orivonApiVersion = ownProperty(value, 'orivonApiVersion', isAny)
  if (orivonApiVersion !== 0) {
    reject(`orivonApiVersion must be exactly 0, got ${describeValue(orivonApiVersion)}`)
  }

  const id = requireString(value, 'id', 1, MAX_ID_LENGTH)
  if (UNSAFE_TEXT_CHARS.test(id)) reject('id contains an unsafe character (a control code, bidi override or zero-width character)')
  if (id.trim().length === 0) reject('id must contain a non-whitespace character')
  if (UNPAIRED_SURROGATE.test(id)) reject(`id contains an unpaired UTF-16 surrogate: ${describeValue(id)}`)

  const name = requireString(value, 'name', 1, MAX_NAME_LENGTH)
  if (UNSAFE_TEXT_CHARS.test(name)) reject('name contains an unsafe character (a control code, bidi override or zero-width character)')
  if (name.trim().length === 0) reject('name must contain a non-whitespace character')

  const version = requireString(value, 'version', 1, MAX_VERSION_LENGTH)
  // Finding 4: previously only compareVersions(version, version) === null was
  // checked. update.ts's OWN parseVersion trims before parsing, so
  // "1.2.3\n" and "1.2.3" compare EQUAL despite being different strings --
  // two spellings of one version, exactly the ambiguity this file refuses
  // for every other field. Checked here, before the orderability check,
  // rather than folded into it, because "\n" alone still parses as orderable
  // semver (it is trimmed away) and would never trip that check at all.
  if (UNSAFE_TEXT_CHARS.test(version)) {
    reject('version contains an unsafe character (a control code, bidi override or zero-width character)')
  }
  if (version.trim() !== version) reject(`version has leading or trailing whitespace: ${describeValue(version)}`)
  // capability-api.md SSversion / update.ts's isAtOrAboveFloor: a version that
  // does not parse as orderable semver fails closed on every future update
  // anyway, stuck below a floor it can never reach -- so the publisher must
  // find out at install, not on their first update. Reuses update.ts's OWN
  // notion of orderable rather than a second parser (Rule 3): a version is
  // orderable exactly when it compares equal to itself.
  if (compareVersions(version, version) === null) {
    reject(`version does not parse as orderable semver: ${describeValue(version)}`)
  }

  const entry = requireString(value, 'entry', 1, MAX_ENTRY_LENGTH)
  validateRelativePath('entry', entry)

  const assets = readAssets(value, entry)

  const capabilitiesRaw = ownProperty(value, 'capabilities', isAny)
  if (capabilitiesRaw === undefined) reject('capabilities is required')
  const capabilities = readCapabilities(capabilitiesRaw, 'capabilities')

  return { orivonApiVersion: 0, id, name, version, entry, ...(assets !== undefined && { assets }), capabilities }
}

function parseJsonText (text: string): unknown {
  if (text.length === 0) reject('manifest text is empty')
  // Byte length, not text.length (UTF-16 code units): bounds the more
  // expensive quantity, and bounds JSON.parse's worst-case nesting depth
  // before it ever runs -- the same reasoning canonical-path.ts's
  // MAX_PATH_BYTES check uses.
  if (new TextEncoder().encode(text).length > MAX_MANIFEST_BYTES) {
    reject(`manifest exceeds ${MAX_MANIFEST_BYTES} bytes`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    reject(`manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}
