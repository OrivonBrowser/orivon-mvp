// Reads and writes everything Orivon itself persists under
// `<userData>/extensions/` -- I/O (`-runner.ts`, src/main/README.md's
// suffix rule): `registry.json` around registry.ts's pure parse/serialise
// (using `writeFileAtomic`, `src/broker/adapters/atomic-write.ts`, the
// same way every other `src/main/` module that persists its own JSON file
// does), and each slot's own `key.pub` and the manifest-key canonicalization
// that install-runner.ts's `finishInstall` resolves a `key` through.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import { parseRegistry, serializeRegistry, type InstalledExtension } from './registry.js'

function extensionsDir (userDataPath: string): string {
  return join(userDataPath, 'extensions')
}

function registryPath (userDataPath: string): string {
  return join(extensionsDir(userDataPath), 'registry.json')
}

/**
 * Never throws: a missing file (nothing installed yet) comes back as `[]`
 * with no side effect. A file that exists but fails to parse (registry.ts's
 * own `parseRegistry` doc explains why the whole file fails closed rather
 * than keeping whatever entries happened to parse) is moved aside to
 * `registry.json.corrupt-<timestamp>` BEFORE this function returns its own
 * `[]` -- the next `writeRegistry` call would otherwise overwrite the
 * corrupt file in place, permanently losing whatever it held. Logs once, at
 * the moved-aside path, so the corrupt file is still there to inspect.
 */
export function readRegistry (userDataPath: string): readonly InstalledExtension[] {
  const path = registryPath(userDataPath)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    console.warn(`[extensions] registry.json unreadable, treating as empty: ${String(error)}`)
    return []
  }
  const { entries, corrupt } = parseRegistry(text)
  if (corrupt) {
    const asidePath = `${path}.corrupt-${String(Date.now())}`
    try {
      renameSync(path, asidePath)
      console.warn(`[extensions] registry.json was not well-formed; moved aside to ${asidePath}, continuing with an empty registry`)
    } catch (error) {
      console.warn(`[extensions] registry.json was not well-formed and could not be moved aside, treating as empty: ${String(error)}`)
    }
  }
  return entries
}

export function writeRegistry (userDataPath: string, entries: readonly InstalledExtension[]): void {
  mkdirSync(extensionsDir(userDataPath), { recursive: true })
  writeFileAtomic(registryPath(userDataPath), serializeRegistry(entries))
}

/** One gate per `userDataPath`: whoever holds it is the only caller allowed
 * to read-modify-write the registry right now. */
const registryGates = new Map<string, Promise<void>>()

/**
 * Runs `fn` against a registry read fresh at the moment `fn` actually
 * starts, with every other `withRegistryLock` call on the same
 * `userDataPath` queued behind it in call order -- install-runner.ts's
 * `finishInstall` (its own final write), `uninstall` and `setEnabled`, and
 * `patchStoreUpdater` below, are the four read-modify-write sites
 * (README.md's Design notes on why a lock is needed at all: the extensions
 * page, the store's own IPC and the vendored updater's background/on-focus
 * checks can all touch the registry at once). `fn` itself calls
 * `writeRegistry` with whatever it decides, based on the fresh read it was
 * handed -- never the copy an earlier, now-stale read produced. A queued
 * call is released whether or not the call ahead of it threw, so one
 * failed operation never wedges every later one.
 */
export async function withRegistryLock<T> (
  userDataPath: string,
  fn: (registry: readonly InstalledExtension[]) => T | Promise<T>
): Promise<T> {
  const turn = registryGates.get(userDataPath) ?? Promise.resolve()
  let release: () => void = () => {}
  registryGates.set(userDataPath, new Promise((resolve) => { release = resolve }))
  await turn
  try {
    return await fn(readRegistry(userDataPath))
  } finally {
    release()
  }
}

/**
 * Merges `patch` into `id`'s own `updater` field, for a store-managed entry
 * only -- a no-op if `id` names nothing, or names an entry whose updater is
 * not `{ kind: 'store' }` (install-runner.ts's `installFromStoreCrx` and
 * store-runner.ts's `onUpdateCheck` wiring are the two callers, recording an
 * update check's result and, when one is held for consent, `pendingUpdate`).
 * Runs under `withRegistryLock` so a check landing while an install or an
 * uninstall is mid-flight never overwrites the other's change.
 */
export async function patchStoreUpdater (
  userDataPath: string,
  id: string,
  patch: { readonly lastCheckedAt?: number, readonly lastResult?: string, readonly pendingUpdate?: { readonly url: string, readonly version: string } }
): Promise<void> {
  await withRegistryLock(userDataPath, (registry) => {
    const entry = registry.find((candidate) => candidate.id === id)
    if (entry === undefined || entry.updater.kind !== 'store') return
    const updater: InstalledExtension['updater'] = { ...entry.updater, ...patch, kind: 'store' }
    writeRegistry(userDataPath, registry.map((candidate) => candidate.id === id ? { ...candidate, updater } : candidate))
  })
}

/** The slot (the first path segment under `<userDataPath>/extensions/`) of
 * the existing `source.kind === 'file'` entry whose id is `id` --
 * `undefined` if none matches. An entry's own `path` is
 * `<extensionsDir>/<slot>/<version>`, so its slot is just that path's first
 * segment. */
export function slotOfFileEntry (userDataPath: string, id: string): string | undefined {
  const entry = readRegistry(userDataPath).find((candidate) => candidate.id === id && candidate.source.kind === 'file')
  if (entry === undefined) return undefined
  return relative(extensionsDir(userDataPath), entry.path).split(sep)[0]
}

function slotKeyPath (userDataPath: string, slot: string): string {
  return join(extensionsDir(userDataPath), slot, 'key.pub')
}

/**
 * The per-slot RSA public key (SPKI DER, base64) that keeps a folder or
 * `.zip` install's extension id stable across every update into `slot` --
 * `resolveInstallKey`'s own doc says where this ranks against a manifest's
 * own `key` and a `.crx`'s developer key. Generated once and persisted at
 * `slotKeyPath`, then reused for every later install into the same slot;
 * the matching private key is never exported, since nothing here signs
 * with it.
 */
export function resolveSlotKey (userDataPath: string, slot: string): string {
  const keyPath = slotKeyPath(userDataPath, slot)
  try {
    return readFileSync(keyPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const encoded = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  mkdirSync(dirname(keyPath), { recursive: true })
  writeFileSync(keyPath, encoded)
  return encoded
}

const STRICT_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * `raw`, as Chromium's own `ParsePEMKeyBytes` would read it, re-encoded to
 * this file's own canonical form (SPKI DER, base64, no armour) -- or
 * `undefined` if it is not a parsable public key at all. Chromium strips a
 * `-----BEGIN ... KEY-----`/`-----END ...-----` wrapper and whitespace
 * before base64-decoding what is left; Node's own `Buffer.from(x,
 * 'base64')` is lenient about invalid characters (it skips them rather than
 * refusing), so decoding the WRAPPED string directly, the way a plain
 * `generateId(manifestKey)` call would, silently produces different bytes
 * than Chromium's own parse of the same text -- and so a different id.
 * Stripping first, then refusing any character outside the base64 alphabet
 * before decoding, then parsing the result as a real SPKI key and
 * re-exporting it, is what makes `generateId` of THIS function's output
 * match what a real Electron session derives for the same manifest `key`,
 * whether or not the person who wrote it wrapped it in PEM armour.
 */
export function canonicalizeManifestKey (raw: string): string | undefined {
  const stripped = raw
    .replace(/-----BEGIN [^-]*-----/g, '')
    .replace(/-----END [^-]*-----/g, '')
    .replace(/\s+/g, '')
  if (stripped.length === 0 || !STRICT_BASE64.test(stripped)) return undefined
  try {
    const der = Buffer.from(stripped, 'base64')
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' })
    return key.export({ type: 'spki', format: 'der' }).toString('base64')
  } catch {
    return undefined
  }
}

export type ResolvedInstallKey =
  | { readonly ok: true, readonly key: string }
  | { readonly ok: false, readonly reason: string }

/**
 * The `key` (SPKI DER, base64) every loaded copy in `slot` carries, so
 * Electron derives a stable id across an update instead of one that embeds
 * the version-numbered load path (README.md's Design notes, "Why every
 * installed copy's manifest carries a key"). A `.crx`'s verified developer
 * key (crx.ts's own doc) wins outright when there is one -- Chrome itself
 * ignores a packed CRX's manifest `key`, so a `.crx` whose manifest claims
 * a different `key` never gets to borrow another extension's id this way.
 * Only a folder or `.zip` install, which carries no signature at all, falls
 * back to the manifest's own `key` (Chrome keeps it there) --
 * canonicalized first (`canonicalizeManifestKey`'s own doc: a manifest
 * `key` is untrusted text, and only the canonical form is ever used, so a
 * PEM-wrapped copy of another installed extension's own key resolves to
 * that SAME extension's id, instead of a different one that would slip
 * past install-runner.ts's own "one id, one slot" check) -- else the
 * slot's generated key.
 */
export function resolveInstallKey (
  userDataPath: string,
  slot: string,
  developerPublicKey: Buffer | undefined,
  manifestKey: string | undefined
): ResolvedInstallKey {
  if (developerPublicKey !== undefined) return { ok: true, key: developerPublicKey.toString('base64') }
  if (manifestKey !== undefined) {
    const canonical = canonicalizeManifestKey(manifestKey)
    return canonical === undefined
      ? { ok: false, reason: 'the manifest key is not a parsable public key' }
      : { ok: true, key: canonical }
  }
  return { ok: true, key: resolveSlotKey(userDataPath, slot) }
}
