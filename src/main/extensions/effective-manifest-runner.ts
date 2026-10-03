// Keeps each installed extension's loaded manifest equal to its base
// manifest with the person's choices applied (effective-manifest.ts): the
// base lives beside the version folders as `<slot>/manifest.base.json`, the
// effective copy is the version folder's own `manifest.json`, and a change
// reloads the extension (remove then load, marked so the dNR service keeps
// its state). Runs under `withRegistryLock` like every other writer of an
// extension's files.
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Session } from 'electron'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import { effectiveManifest, manifestText, type ExtensionManifest } from './effective-manifest.js'
import type { ExtensionPrefsStore } from './extension-prefs.js'
import { beginDnrReload, endDnrReload } from './extensions-dnr.js'
import { readRegistry, withRegistryLock } from './registry-runner.js'
import type { InstalledExtension } from './registry.js'

export const BASE_MANIFEST_FILE = 'manifest.base.json'

/** 'now' reloads at once; 'quiet' waits until no page of the extension is open. */
export type ApplyMode = 'now' | 'quiet'

/** `deferred`: a quiet apply gave up waiting; the next launch applies it before loading. */
export type ApplyResult = 'unchanged' | 'applied' | 'deferred' | 'unknown' | 'failed'

export const QUIET_POLL_MS = 2_000
export const QUIET_MAX_WAIT_MS = 10 * 60_000

export interface ManifestApplierDeps {
  readonly userDataPath: string
  readonly session: Pick<Session, 'extensions'>
  readonly prefs: ExtensionPrefsStore
  /** True while a webContents shows a page of this extension. */
  readonly isOpen: (extensionId: string) => boolean
  /** Brings back the extension's open pages around a reload (extension-pages-reload.ts): `begin` before the remove, `end` and `sweep` once it is loaded again. */
  readonly pages?: { readonly begin: (extensionId: string) => void, readonly end: (extensionId: string) => void, readonly sweep: (extensionId: string) => void }
  readonly wait?: (ms: number) => Promise<void>
  readonly pollMs?: number
  readonly maxWaitMs?: number
}

export interface ManifestApplier {
  applyManifest: (extensionId: string, mode: ApplyMode) => Promise<ApplyResult>
  /** Before anything loads: rewrites every entry's `manifest.json` that differs from its effective manifest. */
  applyAtBoot: () => void
}

export function readBaseManifestText (slotDir: string): string | undefined {
  try {
    return readFileSync(join(slotDir, BASE_MANIFEST_FILE), 'utf8')
  } catch {
    return undefined
  }
}

export function writeBaseManifest (slotDir: string, text: string): void {
  mkdirSync(slotDir, { recursive: true })
  writeFileAtomic(join(slotDir, BASE_MANIFEST_FILE), text)
}

/** Puts the base file back as it was, or removes it when there was none. */
export function restoreBaseManifest (slotDir: string, previous: string | undefined): void {
  if (previous === undefined) rmSync(join(slotDir, BASE_MANIFEST_FILE), { force: true })
  else writeBaseManifest(slotDir, previous)
}

function readText (path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** What `entry` should load now: [base text, effective text], the base made from the loaded copy for an install that predates it. */
function plan (entry: InstalledExtension, prefs: ExtensionPrefsStore): { current: string, next: string } | undefined {
  const loadedPath = join(entry.path, 'manifest.json')
  const current = readText(loadedPath)
  if (current === undefined) return undefined
  const slotDir = dirname(entry.path)
  let base = readBaseManifestText(slotDir)
  if (base === undefined) {
    base = current
    writeBaseManifest(slotDir, base)
  }
  const next = manifestText(effectiveManifest(JSON.parse(base) as ExtensionManifest, prefs.get(entry.id)))
  return { current: manifestText(JSON.parse(current) as ExtensionManifest), next }
}

export function createManifestApplier (deps: ManifestApplierDeps): ManifestApplier {
  const wait = deps.wait ?? (async (ms: number) => { await new Promise<void>((resolve) => setTimeout(resolve, ms)) })
  const pollMs = deps.pollMs ?? QUIET_POLL_MS
  const maxWaitMs = deps.maxWaitMs ?? QUIET_MAX_WAIT_MS
  const waiting = new Map<string, { promise: Promise<ApplyResult>, cancelled: boolean }>()

  async function applyNow (id: string): Promise<ApplyResult> {
    return await withRegistryLock(deps.userDataPath, async (registry) => {
      const entry = registry.find((candidate) => candidate.id === id)
      if (entry === undefined) return 'unknown'
      let decided: ReturnType<typeof plan>
      try {
        decided = plan(entry, deps.prefs)
      } catch (error) {
        console.error(`[extensions] could not work out the manifest of ${id}:`, error)
        return 'failed'
      }
      if (decided === undefined) return 'failed'
      if (decided.next === decided.current) return 'unchanged'
      const loadedPath = join(entry.path, 'manifest.json')
      writeFileAtomic(loadedPath, decided.next)
      if (!entry.enabled || deps.session.extensions.getExtension(id) == null) return 'applied'
      beginDnrReload(id)
      deps.pages?.begin(id)
      try {
        deps.session.extensions.removeExtension(id)
        await deps.session.extensions.loadExtension(entry.path, { allowFileAccess: false })
        return 'applied'
      } catch (error) {
        console.error(`[extensions] reloading ${id} with its new manifest failed; putting the old one back:`, error)
        writeFileAtomic(loadedPath, decided.current)
        await deps.session.extensions.loadExtension(entry.path, { allowFileAccess: false })
          .catch((again: unknown) => { console.error(`[extensions] could not reload ${id}:`, again) })
        return 'failed'
      } finally {
        endDnrReload(id)
        deps.pages?.end(id)
        deps.pages?.sweep(id)
      }
    })
  }

  async function applyWhenQuiet (id: string, state: { cancelled: boolean }): Promise<ApplyResult> {
    for (let waited = 0; deps.isOpen(id); waited += pollMs) {
      if (state.cancelled) return await applyNow(id)
      if (waited >= maxWaitMs) return 'deferred'
      await wait(pollMs)
    }
    return await applyNow(id)
  }

  return {
    applyManifest: async (id, mode) => {
      const pending = waiting.get(id)
      if (mode === 'now') {
        if (pending !== undefined) pending.cancelled = true
        return await applyNow(id)
      }
      if (pending !== undefined) return await pending.promise
      const state = { cancelled: false, promise: Promise.resolve<ApplyResult>('unchanged') }
      state.promise = applyWhenQuiet(id, state).finally(() => { waiting.delete(id) })
      waiting.set(id, state)
      return await state.promise
    },
    applyAtBoot: () => {
      for (const entry of readRegistry(deps.userDataPath)) {
        try {
          const decided = plan(entry, deps.prefs)
          if (decided !== undefined && decided.next !== decided.current && existsSync(entry.path)) {
            writeFileAtomic(join(entry.path, 'manifest.json'), decided.next)
          }
        } catch (error) {
          console.error(`[extensions] could not apply the manifest of ${entry.id} at start:`, error)
        }
      }
    }
  }
}
