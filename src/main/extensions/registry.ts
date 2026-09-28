// Orivon's own record of installed extensions -- pure: parse, serialise and
// describe, no `electron`, no filesystem (registry-runner.ts is the I/O
// half, src/main/README.md's suffix rule). Electron itself remembers
// nothing about a loaded extension across restarts, so this file's shape is
// what extensions-subsystem.ts replays at every boot (./README.md's Design
// notes).

import { isArray, isFiniteNumber, isString, ownProperty } from '../../broker/policy/own-property.js'
import type { StrippedRecord } from '../../broker/policy/extension-manifest.js'

export type ExtensionSource =
  | { readonly kind: 'unpacked', readonly from: string }
  | { readonly kind: 'file', readonly fileName: string }
  | { readonly kind: 'store', readonly storeId: string }

/**
 * Who updates this extension, tracked separately from `source` (a `file`
 * install and an `unpacked` one are both `{ kind: 'none' }`, for different
 * reasons `reason` names) -- the owner's requirement that who updates an
 * extension is always shown means this can never be left implicit in
 * `source` alone.
 */
export type ExtensionUpdater =
  | { readonly kind: 'none', readonly reason: string }
  | { readonly kind: 'store', readonly lastCheckedAt?: number, readonly lastResult?: string }

export interface InstalledExtension {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly enabled: boolean
  readonly installedAt: number
  readonly updatedAt: number
  readonly source: ExtensionSource
  readonly updater: ExtensionUpdater
  /** Absolute path to the loaded folder: `<userData>/extensions/<slot>/<version>/`. */
  readonly path: string
  /** What `loadableManifest` removed from this extension's manifest, kept so
   * those APIs could be served from Orivon's own engine later, and so the
   * extensions page can say what Orivon does not yet run. */
  readonly stripped: StrippedRecord
}

/**
 * The sentence the extensions page shows for `entry`. Chrome Web Store
 * wording comes first regardless of `source`, since `updater.kind` is the
 * fact that actually decides what happens next; `source.kind` only
 * distinguishes the two `'none'` sentences from each other.
 */
export function describeUpdater (entry: InstalledExtension): string {
  if (entry.updater.kind === 'store') {
    return 'Updated by the Chrome Web Store (Google), checked at start and every 5 hours. ' +
      'Each update is checked against Google\'s and the developer\'s signatures before it runs.'
  }
  if (entry.source.kind === 'unpacked') {
    return `No automatic updates. Reload it from ${entry.source.from} to pick up changes.`
  }
  return 'No automatic updates. Install a newer file to update it.'
}

// --- serialisation, strict on the way back in ---

function parseSource (raw: unknown): ExtensionSource | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const kind = ownProperty(raw, 'kind', isString)
  if (kind === 'unpacked') {
    const from = ownProperty(raw, 'from', isString)
    return from === undefined ? undefined : { kind, from }
  }
  if (kind === 'file') {
    const fileName = ownProperty(raw, 'fileName', isString)
    return fileName === undefined ? undefined : { kind, fileName }
  }
  if (kind === 'store') {
    const storeId = ownProperty(raw, 'storeId', isString)
    return storeId === undefined ? undefined : { kind, storeId }
  }
  return undefined
}

function parseUpdater (raw: unknown): ExtensionUpdater | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const kind = ownProperty(raw, 'kind', isString)
  if (kind === 'none') {
    const reason = ownProperty(raw, 'reason', isString)
    return reason === undefined ? undefined : { kind, reason }
  }
  if (kind === 'store') {
    const lastCheckedAt = ownProperty(raw, 'lastCheckedAt', isFiniteNumber)
    const lastResult = ownProperty(raw, 'lastResult', isString)
    return {
      kind,
      ...(lastCheckedAt === undefined ? {} : { lastCheckedAt }),
      ...(lastResult === undefined ? {} : { lastResult })
    }
  }
  return undefined
}

function parseStripped (raw: unknown): StrippedRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const permissions = ownProperty(raw, 'permissions', isArray)
  const optionalPermissions = ownProperty(raw, 'optionalPermissions', isArray)
  if (permissions === undefined || !permissions.every(isString)) return undefined
  if (optionalPermissions === undefined || !optionalPermissions.every(isString)) return undefined
  // declarativeNetRequest is deliberately typed `unknown` (StrippedRecord's
  // own doc): it is whatever JSON value the stripped manifest's
  // declarative_net_request key held, or absent -- nothing here can, or
  // should, validate its shape.
  return {
    permissions: permissions as string[],
    optionalPermissions: optionalPermissions as string[],
    declarativeNetRequest: Object.hasOwn(raw, 'declarativeNetRequest') ? (raw as { declarativeNetRequest: unknown }).declarativeNetRequest : undefined
  }
}

function parseInstalledExtension (raw: unknown): InstalledExtension | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const id = ownProperty(raw, 'id', isString)
  const name = ownProperty(raw, 'name', isString)
  const version = ownProperty(raw, 'version', isString)
  const enabled = ownProperty(raw, 'enabled', (v): v is boolean => typeof v === 'boolean')
  const installedAt = ownProperty(raw, 'installedAt', isFiniteNumber)
  const updatedAt = ownProperty(raw, 'updatedAt', isFiniteNumber)
  const path = ownProperty(raw, 'path', isString)
  const source = parseSource(ownProperty(raw, 'source', (v): v is object => typeof v === 'object' && v !== null))
  const updater = parseUpdater(ownProperty(raw, 'updater', (v): v is object => typeof v === 'object' && v !== null))
  const stripped = parseStripped(ownProperty(raw, 'stripped', (v): v is object => typeof v === 'object' && v !== null))
  if (id === undefined || name === undefined || version === undefined || enabled === undefined ||
    installedAt === undefined || updatedAt === undefined || path === undefined ||
    source === undefined || updater === undefined || stripped === undefined) {
    return undefined
  }
  return { id, name, version, enabled, installedAt, updatedAt, source, updater, path, stripped }
}

export interface ParsedRegistry {
  readonly entries: readonly InstalledExtension[]
  /** True when the text was not this file's own well-formed shape at all --
   * registry-runner.ts logs a warning and treats this the same as "nothing
   * installed yet", never a crash (README.md's Design notes). */
  readonly corrupt: boolean
}

const EMPTY_CORRUPT: ParsedRegistry = { entries: [], corrupt: true }

/**
 * Strict: the whole file is trusted only if every entry in it validates.
 * One malformed entry could as easily be a half-written crash as a bug, and
 * silently keeping the entries that DID parse would load a registry the
 * next write might not reproduce -- failing the whole read closed, the same
 * direction `src/broker/grants/node-ledger-storage.ts`'s version-floor
 * sentinel takes, is what keeps a corrupt file from behaving differently
 * from run to run.
 */
export function parseRegistry (raw: string): ParsedRegistry {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return EMPTY_CORRUPT
  }
  if (typeof parsed !== 'object' || parsed === null) return EMPTY_CORRUPT
  const extensionsRaw = ownProperty(parsed, 'extensions', isArray)
  if (extensionsRaw === undefined) return EMPTY_CORRUPT
  const entries: InstalledExtension[] = []
  for (const item of extensionsRaw) {
    const entry = parseInstalledExtension(item)
    if (entry === undefined) return EMPTY_CORRUPT
    entries.push(entry)
  }
  return { entries, corrupt: false }
}

export function serializeRegistry (entries: readonly InstalledExtension[]): string {
  return JSON.stringify({ extensions: entries })
}
