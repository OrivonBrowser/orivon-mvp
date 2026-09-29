// Reads and writes `<userData>/extensions/registry.json` -- I/O
// (`-runner.ts`, src/main/README.md's suffix rule) around registry.ts's
// pure parse/serialise. Uses `writeFileAtomic`
// (`src/broker/grants/node-ledger-storage.ts`) the same way every other
// `src/main/` module that persists its own JSON file does.

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../../broker/grants/node-ledger-storage.js'
import { parseRegistry, serializeRegistry, type InstalledExtension } from './registry.js'

function extensionsDir (userDataPath: string): string {
  return join(userDataPath, 'extensions')
}

function registryPath (userDataPath: string): string {
  return join(extensionsDir(userDataPath), 'registry.json')
}

/**
 * Never throws: a missing file (nothing installed yet) and a corrupt one
 * both come back as `[]`, the corrupt case logging a warning first
 * (registry.ts's own `parseRegistry` doc explains why the whole file fails
 * closed rather than keeping whatever entries happened to parse).
 */
export function readRegistry (userDataPath: string): readonly InstalledExtension[] {
  let text: string
  try {
    text = readFileSync(registryPath(userDataPath), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    console.warn(`[extensions] registry.json unreadable, treating as empty: ${String(error)}`)
    return []
  }
  const { entries, corrupt } = parseRegistry(text)
  if (corrupt) console.warn('[extensions] registry.json is not well-formed, treating as empty')
  return entries
}

export function writeRegistry (userDataPath: string, entries: readonly InstalledExtension[]): void {
  mkdirSync(extensionsDir(userDataPath), { recursive: true })
  writeFileAtomic(registryPath(userDataPath), serializeRegistry(entries))
}

/**
 * Merges `patch` into `id`'s own `updater` field, for a store-managed entry
 * only -- a no-op if `id` names nothing, or names an entry whose updater is
 * not `{ kind: 'store' }` (install-runner.ts's `installFromStoreCrx` and
 * store-runner.ts's `onUpdateCheck` wiring are the two callers, recording an
 * update check's result and, when one is held for consent, `pendingUpdate`).
 */
export function patchStoreUpdater (
  userDataPath: string,
  id: string,
  patch: { readonly lastCheckedAt?: number, readonly lastResult?: string, readonly pendingUpdate?: { readonly url: string, readonly version: string } }
): void {
  const registry = readRegistry(userDataPath)
  const entry = registry.find((candidate) => candidate.id === id)
  if (entry === undefined || entry.updater.kind !== 'store') return
  const updater: InstalledExtension['updater'] = { ...entry.updater, ...patch, kind: 'store' }
  writeRegistry(userDataPath, registry.map((candidate) => candidate.id === id ? { ...candidate, updater } : candidate))
}
