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

import type {
  Capabilities,
  FsCapability,
  IdCapability,
  Manifest,
  NetCapability,
  Pattern,
  TcpCapability,
  UdpCapability
} from '../contracts/index.js'
import { isValidCanonicalPath } from '../broker/policy/canonical-path.js'
import { MAX_PORT } from '../broker/policy/canonical-host.js'
import { parsePattern as parseConnectPattern } from '../broker/policy/connect-patterns.js'
import { ownProperty } from '../broker/policy/own-property.js'
import { compareVersions } from '../broker/policy/update.js'

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
// real work. MAX_PATTERNS matches connect.ts's own (private) MAX_PATTERNS by
// deliberate coincidence, not a shared constant: that one bounds patterns
// checked per connect() call, this one bounds patterns a manifest may declare.
const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_ID_LENGTH = 255
const MAX_NAME_LENGTH = 200
const MAX_VERSION_LENGTH = 256
const MAX_ENTRY_LENGTH = 1024
const MAX_SCHEME_LENGTH = 32
const MAX_CURVE_LENGTH = 64
const MAX_PATTERNS = 256
const MAX_PROTOCOLS = 32
const MAX_CURVES = 8

/** capability-api.md A9 SS1: privileged ports denied outright, at every tier. */
const MIN_UNPRIVILEGED_PORT = 1024

const MANIFEST_KEYS = ['orivonApiVersion', 'id', 'name', 'version', 'entry', 'capabilities']
const CAPABILITIES_KEYS = ['net', 'fs', 'id', 'protocols']
const NET_KEYS = ['tcp', 'udp']
const TCP_KEYS = ['connect', 'listen']
const UDP_KEYS = ['bind', 'send']
const FS_KEYS = ['quotaBytes']
const ID_CAPABILITY_KEYS = ['curves']

const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/
const PORT_RANGE_PATTERN = /^([1-9][0-9]{0,4})(?:-([1-9][0-9]{0,4}))?$/

// --- internal control flow ------------------------------------------------
//
// A rejection unwinds through a thrown ManifestInvalid rather than threading
// a Result through every nested check -- it never escapes parseManifest's own
// try/catch above, so this is ordinary control flow, not an I/O effect.

class ManifestInvalid extends Error {}

function reject (reason: string): never {
  throw new ManifestInvalid(reason)
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A guard that always succeeds, so ownProperty (own-property.ts) can do a RAW read: undefined means "absent", never "present but rejected by a guard" -- JSON has no undefined value to collide with that. */
function isAny (_value: unknown): _value is unknown {
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
function extraKey (value: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return key
  }
  return null
}

/** Renders an untrusted value for an error message without recursing into it. */
function describeValue (value: unknown): string {
  if (typeof value === 'string') {
    const shown = value.length > 100 ? `${value.slice(0, 100)}...(${value.length} chars)` : value
    return JSON.stringify(shown)
  }
  if (value === undefined) return 'undefined'
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
 */
function optionalStringArray (
  value: Record<string, unknown>,
  path: string,
  key: string,
  max: number,
  validateOne: (item: string, index: number) => void
): readonly string[] | undefined {
  const field = `${path}.${key}`
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

// --- pattern grammars ------------------------------------------------------

/**
 * Bare `lo-hi` or a single port, MAX_PORT-bounded, no leading zeros, no `"*"`.
 * `"*"` is handled by the caller with its own message -- it is a distinct
 * rejection reason (A9 SS1), not a parse failure.
 *
 * A THIRD implementation of this exact grammar, alongside the regex inside
 * connect-patterns.ts's exported `portMatches` and update.ts's PRIVATE
 * `parsePorts`/`parsePort`. Neither is reusable here without a signature
 * change this file cannot legally make (update.ts's version deliberately
 * accepts `"*"`, because it represents an ALREADY-GRANTED pattern set for a
 * coverage check -- the opposite of what a fresh manifest declaration must
 * accept -- and neither exposes the `{lo, hi}` shape this rejection message
 * needs). Flagged rather than silently duplicated -- see the PR description.
 */
function parsePortRange (spec: string): { readonly lo: number, readonly hi: number } | null {
  const match = PORT_RANGE_PATTERN.exec(spec)
  if (match === null) return null
  const loText = match[1]
  if (loText === undefined) return null
  const lo = Number.parseInt(loText, 10)
  const hi = match[2] === undefined ? lo : Number.parseInt(match[2], 10)
  if (lo > MAX_PORT || hi > MAX_PORT || lo > hi) return null
  return { lo, hi }
}

/** `tcp.listen` / `udp.bind`: capability-api.md A9 SS1 -- declared range required, no privileged ports. */
function validatePortRangePattern (pattern: string, field: string): void {
  if (pattern === '*') {
    reject(`${field}: "*" is rejected -- a declared port range is required (capability-api.md A9 SS1)`)
  }
  const range = parsePortRange(pattern)
  if (range === null) reject(`${field} is not a valid port or port range: ${describeValue(pattern)}`)
  if (range.lo < MIN_UNPRIVILEGED_PORT) {
    reject(
      `${field}: privileged ports below ${MIN_UNPRIVILEGED_PORT} are denied at every tier ` +
      `(capability-api.md A9 SS1) -- lowest requested port is ${range.lo}`
    )
  }
}

/**
 * `tcp.connect` / `udp.send`: host:port, `"*:*"` explicitly allowed
 * (capability-api.md).
 *
 * connect-patterns.ts's parsePattern only SPLITS the string -- it does not
 * check that the port half is a real port or range, because at connect time
 * an unreadable port spec just matches nothing (fail closed) rather than
 * needing to be rejected up front. A manifest-time check can and should be
 * pickier: reusing parsePortRange (above) here, rather than accepting
 * anything parsePattern's split tolerates, is a STRICTER subset of what the
 * runtime already treats as valid, so it cannot reject a pattern the runtime
 * would otherwise honour.
 */
function validateConnectPattern (pattern: string, field: string): void {
  const parsed = parseConnectPattern(pattern)
  if (parsed === null) {
    reject(`${field} is not a valid host:port pattern: ${describeValue(pattern)}`)
  }
  if (parsed.port !== '*' && parsePortRange(parsed.port) === null) {
    reject(`${field} has a malformed port: ${describeValue(pattern)}`)
  }
}

function validateSchemeName (scheme: string, field: string): void {
  if (scheme.length > MAX_SCHEME_LENGTH) reject(`${field} exceeds ${MAX_SCHEME_LENGTH} characters`)
  if (!SCHEME_PATTERN.test(scheme)) reject(`${field} is not a valid URI scheme (RFC 3986): ${describeValue(scheme)}`)
}

function validateCurveName (curve: string, field: string): void {
  if (curve.length === 0 || curve.length > MAX_CURVE_LENGTH) {
    reject(`${field} must be 1-${MAX_CURVE_LENGTH} characters`)
  }
  if (CONTROL_CHARS.test(curve)) reject(`${field} contains control characters`)
}

/**
 * `entry` (e.g. `"index.html"`) is relative to the app root, never a
 * canonical `/`-rooted path -- so it is validated by PREFIXING one and
 * reusing canonical-path.ts's isValidCanonicalPath, rather than a second
 * traversal/control-char checker (Rule 3). That catches `..`, NUL and
 * control bytes, encoded traversal, Windows-reserved names and trailing
 * dot/space -- everything T1/T10 care about.
 *
 * Full membership -- "does the bundle actually have a leaf at this path" --
 * is explicitly NOT this file's job: ADR-0009's amendment assigns that check
 * to the app loader's fetch step, which needs the fetched asset tree this
 * file never sees (see this file's header and the PR description).
 */
function validateEntry (entry: string): void {
  if (entry.startsWith('/')) {
    reject(`entry must be a path relative to the app root, without a leading slash: ${describeValue(entry)}`)
  }
  if (isAbsoluteUrl(entry)) {
    reject(`entry must not be an absolute URL or use a URL scheme: ${describeValue(entry)}`)
  }
  if (!isValidCanonicalPath('/' + entry)) {
    reject(`entry is not a safe relative path: ${describeValue(entry)}`)
  }
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

// --- capability shapes -------------------------------------------------------

function readTcp (raw: unknown, path: string): TcpCapability {
  if (!isRecord(raw)) reject(`${path} must be an object, got ${describeValue(raw)}`)
  const extra = extraKey(raw, TCP_KEYS)
  if (extra !== null) reject(`${path} has an unrecognised field: ${describeValue(extra)}`)

  const connect = optionalStringArray(raw, path, 'connect', MAX_PATTERNS, (pattern, i) => {
    validateConnectPattern(pattern, `${path}.connect[${i}]`)
  })
  const listen = optionalStringArray(raw, path, 'listen', MAX_PATTERNS, (pattern, i) => {
    validatePortRangePattern(pattern, `${path}.listen[${i}]`)
  })

  const result: { connect?: readonly Pattern[], listen?: readonly Pattern[] } = {}
  if (connect !== undefined) result.connect = connect
  if (listen !== undefined) result.listen = listen
  return result
}

function readUdp (raw: unknown, path: string): UdpCapability {
  if (!isRecord(raw)) reject(`${path} must be an object, got ${describeValue(raw)}`)
  const extra = extraKey(raw, UDP_KEYS)
  if (extra !== null) reject(`${path} has an unrecognised field: ${describeValue(extra)}`)

  const bind = optionalStringArray(raw, path, 'bind', MAX_PATTERNS, (pattern, i) => {
    validatePortRangePattern(pattern, `${path}.bind[${i}]`)
  })
  const send = optionalStringArray(raw, path, 'send', MAX_PATTERNS, (pattern, i) => {
    validateConnectPattern(pattern, `${path}.send[${i}]`)
  })

  const result: { bind?: readonly Pattern[], send?: readonly Pattern[] } = {}
  if (bind !== undefined) result.bind = bind
  if (send !== undefined) result.send = send
  return result
}

function readNet (raw: unknown, path: string): NetCapability {
  if (!isRecord(raw)) reject(`${path} must be an object, got ${describeValue(raw)}`)
  const extra = extraKey(raw, NET_KEYS)
  if (extra !== null) reject(`${path} has an unrecognised field: ${describeValue(extra)}`)

  const tcpRaw = ownProperty(raw, 'tcp', isAny)
  const udpRaw = ownProperty(raw, 'udp', isAny)

  const result: { tcp?: TcpCapability, udp?: UdpCapability } = {}
  if (tcpRaw !== undefined) result.tcp = readTcp(tcpRaw, `${path}.tcp`)
  if (udpRaw !== undefined) result.udp = readUdp(udpRaw, `${path}.udp`)
  return result
}

function readFs (raw: unknown, path: string): FsCapability {
  if (!isRecord(raw)) reject(`${path} must be an object, got ${describeValue(raw)}`)
  const extra = extraKey(raw, FS_KEYS)
  if (extra !== null) reject(`${path} has an unrecognised field: ${describeValue(extra)}`)

  const quotaRaw = ownProperty(raw, 'quotaBytes', isAny)
  if (quotaRaw === undefined) return {}
  if (typeof quotaRaw !== 'number' || !Number.isFinite(quotaRaw)) {
    reject(`${path}.quotaBytes must be a finite number, got ${describeValue(quotaRaw)}`)
  }
  if (!Number.isInteger(quotaRaw)) reject(`${path}.quotaBytes must be an integer, got ${quotaRaw}`)
  if (quotaRaw <= 0) reject(`${path}.quotaBytes must be positive, got ${quotaRaw}`)
  if (!Number.isSafeInteger(quotaRaw)) reject(`${path}.quotaBytes exceeds Number.MAX_SAFE_INTEGER`)
  return { quotaBytes: quotaRaw }
}

function readIdCapability (raw: unknown, path: string): IdCapability {
  if (!isRecord(raw)) reject(`${path} must be an object, got ${describeValue(raw)}`)
  const extra = extraKey(raw, ID_CAPABILITY_KEYS)
  if (extra !== null) reject(`${path} has an unrecognised field: ${describeValue(extra)}`)

  // `curve` is a free-form string by design (derive-p256.ts: "the contract
  // types curve as a free-form string" -- an unsupported curve is a runtime
  // 'invalid', not a manifest-shape error), so only hygiene is checked here.
  const curves = optionalStringArray(raw, path, 'curves', MAX_CURVES, (curve, i) => {
    validateCurveName(curve, `${path}.curves[${i}]`)
  })
  return curves === undefined ? {} : { curves }
}

function readCapabilities (raw: unknown, path: string): Capabilities {
  if (!isRecord(raw)) reject(`${path} must be an object, got ${describeValue(raw)}`)
  const extra = extraKey(raw, CAPABILITIES_KEYS)
  if (extra !== null) reject(`${path} has an unrecognised field: ${describeValue(extra)}`)

  const netRaw = ownProperty(raw, 'net', isAny)
  const fsRaw = ownProperty(raw, 'fs', isAny)
  const idRaw = ownProperty(raw, 'id', isAny)
  const protocols = optionalStringArray(raw, path, 'protocols', MAX_PROTOCOLS, (scheme, i) => {
    validateSchemeName(scheme, `${path}.protocols[${i}]`)
  })

  const result: { net?: NetCapability, fs?: FsCapability, id?: IdCapability, protocols?: readonly string[] } = {}
  if (netRaw !== undefined) result.net = readNet(netRaw, `${path}.net`)
  if (fsRaw !== undefined) result.fs = readFs(fsRaw, `${path}.fs`)
  if (idRaw !== undefined) result.id = readIdCapability(idRaw, `${path}.id`)
  if (protocols !== undefined) result.protocols = protocols
  return result
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
  if (CONTROL_CHARS.test(id)) reject('id contains control characters')

  const name = requireString(value, 'name', 1, MAX_NAME_LENGTH)
  if (CONTROL_CHARS.test(name)) reject('name contains control characters')

  const version = requireString(value, 'version', 1, MAX_VERSION_LENGTH)
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
  validateEntry(entry)

  const capabilitiesRaw = ownProperty(value, 'capabilities', isAny)
  if (capabilitiesRaw === undefined) reject('capabilities is required')
  const capabilities = readCapabilities(capabilitiesRaw, 'capabilities')

  return { orivonApiVersion: 0, id, name, version, entry, capabilities }
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
