// The per-extension preferences store behind `ExtensionsApi.prefs`:
// `<userData>/extensions/prefs.json`, read once at construction (`get` is
// synchronous, and permission checks call it on hot paths) and written
// debounced and atomically. A private runtime keeps everything in memory.
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import { DebouncedWriter } from '../storage/debounced-writer.js'
import {
  DEFAULT_EXTENSION_PREFS, mergePrefs, parsePrefsFile, prefsEqual, serializePrefs,
  type ExtensionPrefs, type ExtensionPrefsStore
} from './extension-prefs.js'

export interface PersistedExtensionPrefsStore extends ExtensionPrefsStore {
  /** Resolves once the file reflects every change made so far. Never rejects. */
  flush: () => Promise<void>
}

export function prefsFilePath (userDataPath: string): string {
  return join(userDataPath, 'extensions', 'prefs.json')
}

function readFromDisk (filePath: string): Map<string, ExtensionPrefs> {
  try {
    return parsePrefsFile(readFileSync(filePath, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[extensions] prefs.json unreadable, using the defaults:', error)
    return new Map()
  }
}

/** `filePath` null keeps the choices in memory only (a private or guest runtime never writes a new store file). */
export function createExtensionPrefsStore (filePath: string | null): PersistedExtensionPrefsStore {
  const records = filePath === null ? new Map<string, ExtensionPrefs>() : readFromDisk(filePath)
  const listeners = new Set<(id: string) => void>()
  const writer = new DebouncedWriter(async () => {
    if (filePath === null) return
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileAtomic(filePath, serializePrefs(records))
    } catch (error) {
      console.error('[extensions] failed to persist prefs.json:', error)
      throw error
    }
  })

  function changed (id: string): void {
    if (filePath !== null) writer.schedule()
    for (const listener of [...listeners]) listener(id)
  }

  return {
    get: (id) => records.get(id) ?? DEFAULT_EXTENSION_PREFS,
    update: (id, patch) => {
      const before = records.get(id) ?? DEFAULT_EXTENSION_PREFS
      const after = mergePrefs(before, patch)
      if (prefsEqual(before, after)) return
      records.set(id, after)
      changed(id)
    },
    forget: (id) => {
      if (records.delete(id)) changed(id)
    },
    onChange: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    flush: async () => { await writer.flush().catch(() => {}) }
  }
}
