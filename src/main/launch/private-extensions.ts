// The extensions a private session starts with: each one the opening profile runs and allows in private windows, with a copy of
// its own files, choices and data. Plain Node, so it outlives the engine; Windows may hold a file open in the profile's process, so
// every file is copied on its own and a failure is logged, never raised (a private window must open whatever happens here).
import { createHash } from 'node:crypto'
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import { normalizePrefs, parsePrefsFile, serializePrefs } from '../extensions/extension-prefs.js'
import type { ExtensionPrefs } from '../extensions/extension-prefs.js'
import { parseRegistry, serializeRegistry } from '../extensions/registry.js'
import type { InstalledExtension } from '../extensions/registry.js'
import { PROFILES, profilePartition } from '../route/site-partition.js'

const EXTENSION_ID = /^[a-p]{32}$/

/** The choices a private session is given. A field that is not named here is not carried over, so one added later (a camera or microphone answer) stays in the profile until it is named. */
const COPIED_CHOICES = ['granted', 'siteAccess', 'pinned', 'shortcuts', 'overrides', 'noticeSeen', 'privateWindows'] as const

export interface PrivateExtensionsOptions {
  readonly log?: (message: string) => void
  /** Copies one file; a test makes it fail. */
  readonly copyFile?: (from: string, to: string) => void
}

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

/** Copies a tree file by file, leaving out links and `LOCK` files. False when any file could not be copied. */
function copyTree (from: string, to: string, copyFile: (from: string, to: string) => void, log: (message: string) => void): boolean {
  let whole = true
  let stat
  try {
    stat = lstatSync(from)
  } catch {
    return true
  }
  if (!stat.isDirectory()) return true
  try {
    mkdirSync(to, { recursive: true, mode: 0o700 })
    for (const item of readdirSync(from, { withFileTypes: true })) {
      const source = join(from, item.name)
      const target = join(to, item.name)
      if (item.isSymbolicLink()) continue
      if (item.isDirectory()) {
        if (!copyTree(source, target, copyFile, log)) whole = false
      } else if (item.isFile() && item.name !== 'LOCK') {
        try {
          copyFile(source, target)
        } catch (error) {
          whole = false
          log(`[private] could not copy ${source}: ${describe(error)}`)
        }
      }
    }
  } catch (error) {
    whole = false
    log(`[private] could not read ${from}: ${describe(error)}`)
  }
  return whole
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

function defaultCopyFile (from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
  copyFileSync(from, to)
}

/**
 * Gives the private session folder `into` the extensions of the profile folder `from` that are on and allowed in private
 * windows: their files, a registry and a choices file of just those, and a copy of their data. Returns the ids copied.
 * A store that cannot be copied whole is left out (blank data is a better start than a damaged store); an extension whose own
 * files cannot be copied is left out altogether.
 */
export function copyPrivateExtensions (from: string, into: string, options: PrivateExtensionsOptions = {}): string[] {
  const log = options.log ?? ((message: string) => { console.warn(message) })
  const copyFile = options.copyFile ?? defaultCopyFile
  const copied: string[] = []
  try {
    const extensionsDir = join(from, 'extensions')
    const registryText = readText(join(extensionsDir, 'registry.json'))
    if (registryText === undefined) return copied
    const prefs = parsePrefsFile(readText(join(extensionsDir, 'prefs.json')) ?? '')
    const entries: InstalledExtension[] = []
    const choices = new Map<string, ExtensionPrefs>()

    for (const entry of parseRegistry(registryText).entries) {
      const chosen = prefs.get(entry.id)
      if (!entry.enabled || chosen?.privateWindows !== true || !EXTENSION_ID.test(entry.id)) continue
      const inside = relative(extensionsDir, entry.path)
      const [slot] = inside.split(sep)
      if (slot === undefined || slot === '' || slot === '..' || isAbsolute(inside)) {
        log(`[private] ${entry.id} is not inside the extensions folder, not copied`)
        continue
      }
      const target = join(into, 'extensions', slot)
      if (!copyTree(join(extensionsDir, slot), target, copyFile, log)) {
        rmSync(target, { recursive: true, force: true })
        log(`[private] the files of ${entry.id} could not be copied, so it does not run in this private window`)
        continue
      }
      copyData(from, into, entry.id, copyFile, log)
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

function copyData (from: string, into: string, id: string, copyFile: (from: string, to: string) => void, log: (message: string) => void): void {
  const roots = sessionRoots(from)
  const targets = sessionRoots(into)
  roots.forEach((root, index) => {
    for (const folder of dataFolders(id)) {
      const target = join(targets[index] ?? into, folder)
      if (!copyTree(join(root, folder), target, copyFile, log)) {
        rmSync(target, { recursive: true, force: true })
        log(`[private] the data of ${id} in ${folder} could not be copied, so it starts blank there`)
      }
    }
  })
}
