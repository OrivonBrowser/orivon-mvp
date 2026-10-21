// The extensions a private session starts with: each one the opening profile runs and allows in private windows, with a copy of
// its own files, choices and data. Plain Node, so it outlives the engine. The copy is asynchronous and a few files at a time:
// an extension can hold tens of megabytes, and the window that asked for a private one must stay responsive while it runs.
// Windows may hold a file open in the profile's process, so every file is copied on its own and a failure is logged, never
// raised (a private window must open whatever happens here).
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import { normalizePrefs, parsePrefsFile, serializePrefs } from '../extensions/extension-prefs.js'
import type { ExtensionPrefs } from '../extensions/extension-prefs.js'
import { parseRegistry, serializeRegistry } from '../extensions/registry.js'
import type { InstalledExtension } from '../extensions/registry.js'
import { PROFILES, profilePartition } from '../route/site-partition.js'

const EXTENSION_ID = /^[a-p]{32}$/

/** The choices a private session is given. A field that is not named here is not carried over, so one added later (a camera or microphone answer) stays in the profile until it is named. */
const COPIED_CHOICES = ['granted', 'siteAccess', 'pinned', 'shortcuts', 'overrides', 'noticeSeen', 'privateWindows'] as const

/** How many files are copied at once: enough to keep the disk busy, few enough not to starve the process that asked. */
const FILES_AT_ONCE = 6

export interface PrivateExtensionsOptions {
  readonly log?: (message: string) => void
  /** Copies one file; a test makes it fail or watches it. */
  readonly copyFile?: (from: string, to: string) => Promise<void>
}

type CopyFile = (from: string, to: string) => Promise<void>

/** `prefs` as a private session is given it. */
export function privateCopyOfPrefs (prefs: ExtensionPrefs): ExtensionPrefs {
  const kept: Record<string, unknown> = {}
  for (const name of COPIED_CHOICES) kept[name] = prefs[name]
  return normalizePrefs(kept)
}

/**
 * Where an extension keeps what is its own under one session's folder: the stores behind chrome.storage, its IndexedDB, and the
 * service worker's cache (named by the hash Chromium makes of the extension's storage key). Never `Local Storage`, whose one
 * database holds the websites' as well, nor the service worker registrations, cookies, history or caches websites share.
 */
function dataFolders (id: string): readonly string[] {
  return [
    join('Local Extension Settings', id),
    join('Sync Extension Settings', id),
    join('IndexedDB', `chrome-extension_${id}_0.indexeddb.leveldb`),
    join('IndexedDB', `chrome-extension_${id}_0.indexeddb.blob`),
    join('Service Worker', 'CacheStorage', createHash('sha1').update(`chrome-extension_${id}_0`).digest('hex'))
  ]
}

/** The folders that hold sessions of the profile: the default session's is the profile's own, the others are the tunnels'. */
function sessionRoots (profileDir: string): readonly string[] {
  return [profileDir, ...PROFILES.map((profile) => join(profileDir, 'Partitions', profilePartition(profile, true).replace(/^persist:/, '')))]
}

/** Runs at most `limit` tasks at a time, in the order they were asked for. */
function limiter (limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0
  const waiting: Array<() => void> = []
  const next = (): void => { running -= 1; waiting.shift()?.() }
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= limit) await new Promise<void>((resolve) => { waiting.push(resolve) })
    running += 1
    try {
      return await task()
    } finally {
      next()
    }
  }
}

/** Copies a tree, a few files at a time, leaving out links and `LOCK` files. False when any file could not be copied. */
async function copyTree (from: string, to: string, copy: CopyFile, log: (message: string) => void, slot: ReturnType<typeof limiter> = limiter(FILES_AT_ONCE)): Promise<boolean> {
  let stat
  try {
    stat = await lstat(from)
  } catch {
    return true
  }
  if (!stat.isDirectory()) return true
  try {
    await mkdir(to, { recursive: true, mode: 0o700 })
    const results = await Promise.all((await readdir(from, { withFileTypes: true })).map(async (item): Promise<boolean> => {
      const source = join(from, item.name)
      const target = join(to, item.name)
      if (item.isSymbolicLink()) return true
      if (item.isDirectory()) return await copyTree(source, target, copy, log, slot)
      if (!item.isFile() || item.name === 'LOCK') return true
      try {
        await slot(async () => { await copy(source, target) })
        return true
      } catch (error) {
        log(`[private] could not copy ${source}: ${describe(error)}`)
        return false
      }
    }))
    return results.every(Boolean)
  } catch (error) {
    log(`[private] could not read ${from}: ${describe(error)}`)
    return false
  }
}

function describe (error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code
  return code === undefined ? String(error) : `${code} ${String(error)}`
}

function readText (path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

async function defaultCopyFile (from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true, mode: 0o700 })
  await copyFile(from, to)
}

/** Whether `path` is `<extensionsDir>/<slot>/<version>`, the folders compared as they really are. */
function isInside (extensionsDir: string, path: string): boolean {
  try {
    return realpathSync(dirname(dirname(path))) === realpathSync(extensionsDir)
  } catch {
    return false
  }
}

interface Allowed {
  readonly entry: InstalledExtension
  readonly slot: string
  /** The entry's path below the extensions folder: `<slot>/<version>`. */
  readonly inside: string
  readonly chosen: ExtensionPrefs
}

/** The extensions of the profile folder `from` that are on and allowed in private windows. Reads two small files; never throws. */
function allowedIn (from: string, log: (message: string) => void): Allowed[] {
  const found: Allowed[] = []
  try {
    const extensionsDir = join(from, 'extensions')
    const registryText = readText(join(extensionsDir, 'registry.json'))
    if (registryText === undefined) return found
    const prefs = parsePrefsFile(readText(join(extensionsDir, 'prefs.json')) ?? '')
    for (const entry of parseRegistry(registryText).entries) {
      const chosen = prefs.get(entry.id)
      if (!entry.enabled || chosen?.privateWindows !== true || !EXTENSION_ID.test(entry.id)) continue
      // `<extensions>/<slot>/<version>`, compared by where the folders really are: the registry may name the profile through a
      // link (macOS temp folders), and a path that climbs out of the folder resolves to somewhere else.
      const slot = basename(dirname(entry.path))
      if (!isInside(extensionsDir, entry.path) || slot === '' || slot === '.' || slot === '..') {
        log(`[private] ${entry.id} is not inside the extensions folder, not copied`)
        continue
      }
      const inside = join(slot, basename(entry.path))
      found.push({ entry, slot, inside, chosen })
    }
  } catch (error) {
    log(`[private] the extensions could not be read: ${describe(error)}`)
  }
  return found
}

/** Whether a private session opened from `from` has any extension to copy, so a caller with nothing to wait for need not wait. */
export function hasPrivateExtensions (from: string): boolean {
  return allowedIn(from, () => {}).length > 0
}

/**
 * Gives the private session folder `into` the extensions of the profile folder `from` that are on and allowed in private
 * windows: their files, a registry and a choices file of just those, and a copy of their data. Resolves to the ids copied and
 * never rejects. A store that cannot be copied whole is left out (blank data is a better start than a damaged store); an
 * extension whose own files cannot be copied is left out altogether.
 */
export async function copyPrivateExtensions (from: string, into: string, options: PrivateExtensionsOptions = {}): Promise<string[]> {
  const log = options.log ?? ((message: string) => { console.warn(message) })
  const copy = options.copyFile ?? defaultCopyFile
  const copied: string[] = []
  try {
    const extensionsDir = join(from, 'extensions')
    const entries: InstalledExtension[] = []
    const choices = new Map<string, ExtensionPrefs>()

    for (const { entry, slot, inside, chosen } of allowedIn(from, log)) {
      const target = join(into, 'extensions', slot)
      if (!await copyTree(join(extensionsDir, slot), target, copy, log)) {
        await rm(target, { recursive: true, force: true }).catch(() => {})
        log(`[private] the files of ${entry.id} could not be copied, so it does not run in this private window`)
        continue
      }
      await copyData(from, into, entry.id, copy, log)
      entries.push({ ...entry, path: join(into, 'extensions', inside) })
      choices.set(entry.id, privateCopyOfPrefs(chosen))
      copied.push(entry.id)
    }

    if (entries.length > 0) {
      writeFileAtomic(join(into, 'extensions', 'registry.json'), serializeRegistry(entries))
      writeFileAtomic(join(into, 'extensions', 'prefs.json'), serializePrefs(choices))
    }
  } catch (error) {
    log(`[private] the extensions could not be copied: ${describe(error)}`)
  }
  return copied
}

async function copyData (from: string, into: string, id: string, copy: CopyFile, log: (message: string) => void): Promise<void> {
  const roots = sessionRoots(from)
  const targets = sessionRoots(into)
  for (const [index, root] of roots.entries()) {
    for (const folder of dataFolders(id)) {
      const target = join(targets[index] ?? into, folder)
      if (!await copyTree(join(root, folder), target, copy, log)) {
        await rm(target, { recursive: true, force: true }).catch(() => {})
        log(`[private] the data of ${id} in ${folder} could not be copied, so it starts blank there`)
      }
    }
  }
}
