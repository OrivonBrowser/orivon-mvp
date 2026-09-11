// The `capabilities` sub-tree of a manifest -- split out of ./manifest.ts
// (docs/development/code-guidelines.md Rule 2). Owns net/fs/id/protocols
// shape validation and the pattern grammars
// (host:port, port range, URI scheme, curve name) those fields are built
// from. Top-level manifest fields (id, name, version, entry) stay in
// manifest.ts -- this file is specifically the "per-capability read*
// functions" seam, not a general second half of the validator.
//
// Same stance as manifest.ts: THE INPUT IS ADVERSARIAL, every check REJECTS
// rather than repairs, and every rejection reason is developer-facing (see
// manifest.ts's header -- not repeated here).

import type {
  Capabilities,
  FsCapability,
  IdCapability,
  NetCapability,
  Pattern,
  TcpCapability,
  UdpCapability
} from '../contracts/index.js'
import { MAX_HOST_LENGTH, MAX_PORT } from '../broker/policy/canonical-host.js'
import { declarableConnectHostRejection, parsePattern as parseConnectPattern } from '../broker/policy/connect-patterns.js'
import { ownProperty } from '../broker/policy/own-property.js'
import { UNSAFE_TEXT_CHARS, describeValue, extraKey, isAny, isRecord, optionalStringArray, reject } from './manifest.js'

// --- bounds ----------------------------------------------------------------
//
// AI-chosen, not specified anywhere in the spec -- flagged rather than
// silently assumed (CLAUDE.md Rule 1). MAX_PATTERNS matches connect.ts's own
// (private) MAX_PATTERNS by deliberate coincidence, not a shared constant:
// that one bounds patterns checked per connect() call, this one bounds
// patterns a manifest may declare.
const MAX_SCHEME_LENGTH = 32
const MAX_CURVE_LENGTH = 64
const MAX_PATTERNS = 256
const MAX_PROTOCOLS = 32
const MAX_CURVES = 8

/** capability-api.md's open item A9, point 1: privileged ports denied outright, at every tier. */
const MIN_UNPRIVILEGED_PORT = 1024

const CAPABILITIES_KEYS = ['net', 'fs', 'id', 'protocols']
const NET_KEYS = ['tcp', 'udp', 'concurrentSockets']
const TCP_KEYS = ['connect', 'listen']
const UDP_KEYS = ['bind', 'send']
const FS_KEYS = ['quotaBytes']
const ID_CAPABILITY_KEYS = ['curves']

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/
const PORT_RANGE_PATTERN = /^([1-9][0-9]{0,4})(?:-([1-9][0-9]{0,4}))?$/

// --- pattern grammars --------------------------------------------------------

/**
 * Bare `lo-hi` or a single port, MAX_PORT-bounded, no leading zeros, no `"*"`.
 * `"*"` is handled by the caller with its own message -- it is a distinct
 * rejection reason (capability-api.md's open item A9, point 1), not a
 * parse failure.
 *
 * A THIRD implementation of this exact grammar, alongside the regex inside
 * connect-patterns.ts's exported `portMatches` and update.ts's PRIVATE
 * `parsePorts`/`parsePort`. Neither is reusable here without a signature
 * change this file cannot legally make (update.ts's version deliberately
 * accepts `"*"`, because it represents an ALREADY-GRANTED pattern set for a
 * coverage check -- the opposite of what a fresh manifest declaration must
 * accept -- and neither exposes the `{lo, hi}` shape this rejection message
 * needs). A known Rule-3 duplicate, not fixed here because doing so would
 * need a signature change to a file this one may not restructure alone.
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

/** `tcp.listen` / `udp.bind`: capability-api.md's open item A9, point 1 -- declared range required, no privileged ports. */
function validatePortRangePattern (pattern: string, field: string): void {
  if (pattern === '*') {
    reject(`${field}: "*" is rejected -- a declared port range is required (capability-api.md's open item A9, point 1)`)
  }
  const range = parsePortRange(pattern)
  if (range === null) reject(`${field} is not a valid port or port range: ${describeValue(pattern)}`)
  if (range.lo < MIN_UNPRIVILEGED_PORT) {
    reject(
      `${field}: privileged ports below ${MIN_UNPRIVILEGED_PORT} are denied at every tier ` +
      `(capability-api.md's open item A9, point 1) -- lowest requested port is ${range.lo}`
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
  // parseConnectPattern trims the WHOLE pattern before splitting, so leading
  // or trailing whitespace never survives into `parsed.host` -- but the
  // ORIGINAL string is what gets stored in the manifest and rendered in the
  // grant prompt (optionalStringArray pushes the raw item, never a trimmed
  // one). Checked on the raw pattern, not `parsed.host`, so this catches the
  // padding parseConnectPattern's own trim would otherwise hide from us.
  if (pattern !== pattern.trim()) {
    reject(`${field} has leading or trailing whitespace: ${describeValue(pattern)}`)
  }
  const parsed = parseConnectPattern(pattern)
  if (parsed === null) {
    reject(`${field} is not a valid host:port pattern: ${describeValue(pattern)}`)
  }
  if (parsed.port !== '*' && parsePortRange(parsed.port) === null) {
    reject(`${field} has a malformed port: ${describeValue(pattern)}`)
  }
  validateConnectHost(parsed.host, pattern, field)
}

/**
 * The host half of a connect/send pattern -- previously unchecked entirely
 * (finding 2). The DECISION (which hosts a manifest may declare, and why --
 * every reason here is one `hostMatches` would deny on EVERY call, so
 * rejecting it up front can never refuse a pattern the runtime would
 * otherwise have honoured) now lives in `declarableConnectHostRejection`
 * (`../broker/policy/connect-patterns.js`): `../broker/policy/request-
 * grant.ts` needs the exact same grammar for its own `requestGrant()` check
 * (R2-01), and `src/broker/` may never import `src/loader/`
 * (`../broker/README.md`) -- the same precedent `policy/manifest-
 * patterns.ts` already set for `patternSetFromCapabilities`. What stays
 * here is only the developer-facing MESSAGE per rejection reason -- one
 * implementation of the grammar, one of the wording (code-guidelines.md
 * Rule 3), never two of either.
 */
function validateConnectHost (host: string, pattern: string, field: string): void {
  const rejection = declarableConnectHostRejection(host, pattern)
  if (rejection === null) return
  switch (rejection) {
    case 'wildcard-needs-wildcard-port':
      reject(
        `${field}: the "*" wildcard host is only accepted paired with a "*" port, as "*:*" ` +
        `(capability-api.md's only documented wildcard declaration) -- got ${describeValue(pattern)}`
      )
      break
    case 'sub-glob':
      reject(
        `${field}: sub-glob hosts are not supported -- ${describeValue(host)} would match nothing ` +
        `at connect time (connect-patterns.ts has no sub-glob support); write the literal host instead`
      )
      break
    case 'non-ascii':
      reject(`${field} has a non-ASCII host: ${describeValue(host)}`)
      break
    case 'too-long':
      reject(`${field} host exceeds ${MAX_HOST_LENGTH} characters: ${describeValue(host)}`)
      break
    case 'not-canonical':
      reject(`${field} host is not written canonically (whitespace or case) -- write it exactly as it will be compared: ${describeValue(host)}`)
      break
    case 'empty-label':
      reject(`${field} host has an empty label: ${describeValue(host)}`)
      break
    case 'address-not-canonical':
      reject(`${field} host is address-shaped but not written canonically, so it matches nothing at connect time: ${describeValue(host)}`)
      break
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
  if (UNSAFE_TEXT_CHARS.test(curve)) reject(`${field} contains control characters`)
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

  const result: { tcp?: TcpCapability, udp?: UdpCapability, concurrentSockets?: number } = {}
  if (tcpRaw !== undefined) result.tcp = readTcp(tcpRaw, `${path}.tcp`)
  if (udpRaw !== undefined) result.udp = readUdp(udpRaw, `${path}.udp`)

  // NOT bounded against LIMITS.concurrentSockets here. The broker clamps it
  // instead (GrantLedger.socketAllowance), so raising or lowering the platform
  // ceiling never turns an already-published manifest into an invalid one --
  // see contracts/manifest.ts's own note on the field.
  const declared = readPositiveInteger(raw, path, 'concurrentSockets')
  if (declared !== undefined) result.concurrentSockets = declared
  return result
}

/**
 * The declared-quota grammar, shared by `fs.quotaBytes` and
 * `net.concurrentSockets` (code-guidelines.md Rule 3 -- the REASON is shared,
 * not just the shape: both are an app declaring a positive integer budget the
 * broker then enforces).
 */
function readPositiveInteger (raw: Record<string, unknown>, path: string, field: string): number | undefined {
  const value = ownProperty(raw, field, isAny)
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    reject(`${path}.${field} must be a finite number, got ${describeValue(value)}`)
  }
  if (!Number.isInteger(value)) reject(`${path}.${field} must be an integer, got ${value}`)
  if (value <= 0) reject(`${path}.${field} must be positive, got ${value}`)
  if (!Number.isSafeInteger(value)) reject(`${path}.${field} exceeds Number.MAX_SAFE_INTEGER`)
  return value
}

function readFs (raw: unknown, path: string): FsCapability {
  if (!isRecord(raw)) reject(`${path} must be an object, got ${describeValue(raw)}`)
  const extra = extraKey(raw, FS_KEYS)
  if (extra !== null) reject(`${path} has an unrecognised field: ${describeValue(extra)}`)

  const quotaBytes = readPositiveInteger(raw, path, 'quotaBytes')
  return quotaBytes === undefined ? {} : { quotaBytes }
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

/** Reads and validates the `capabilities` sub-tree. Called from manifest.ts's readManifest. */
export function readCapabilities (raw: unknown, path: string): Capabilities {
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
