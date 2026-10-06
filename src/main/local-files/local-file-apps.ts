import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import { isLocalFileKey, localFileKey } from '../../broker/policy/origin.js'

const FILE_VERSION = 1

/** Past this many files a new one is refused: each recorded file keeps a session folder of its own on disk. */
export const MAX_RECORDED_FILES = 500

/**
 * The local files a person let use Orivon permissions, in `<userData>/local-file-apps.json`: one
 * local-file key each (`localFileKey`). A recorded key runs in a session of its own and is the only
 * kind that holds grants; the record picks the session, never a live grant. Written when the person
 * answers Yes, read once at construction, and a file that cannot be read is an empty record.
 */
export class LocalFileApps {
  private readonly keys = new Set<string>()

  constructor (private readonly filePath: string) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || (parsed as { version?: unknown }).version !== FILE_VERSION) return
      const files = (parsed as { files?: unknown }).files
      if (!Array.isArray(files)) return
      for (const entry of files) {
        if (typeof entry === 'string' && isLocalFileKey(entry) && this.keys.size < MAX_RECORDED_FILES) this.keys.add(entry)
      }
    } catch {
      // Missing or corrupt: nothing is recorded, so nothing holds a grant.
    }
  }

  has (key: string): boolean {
    return this.keys.has(key)
  }

  list (): string[] {
    return [...this.keys]
  }

  /** True when `key` is recorded afterwards. False for a string that is not a key, a full record, or a write that failed (nothing is then recorded). */
  add (key: string): boolean {
    if (!isLocalFileKey(key)) return false
    if (this.keys.has(key)) return true
    if (this.keys.size >= MAX_RECORDED_FILES) return false
    this.keys.add(key)
    if (this.persist()) return true
    this.keys.delete(key)
    return false
  }

  /** True when `key` was recorded and no longer is. A failed write puts it back, so memory never says less than disk. */
  remove (key: string): boolean {
    if (!this.keys.delete(key)) return false
    if (this.persist()) return true
    this.keys.add(key)
    return false
  }

  private persist (): boolean {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileAtomic(this.filePath, JSON.stringify({ version: FILE_VERSION, files: [...this.keys] }, null, 2))
      return true
    } catch (error) {
      console.error('[orivon] failed to persist the local files allowed to use Orivon permissions:', error)
      return false
    }
  }
}

let installed: LocalFileApps | undefined

/** The record the whole shell consults, set once by the local-files subsystem (and by a test); undefined until then. */
export function installLocalFileApps (apps: LocalFileApps | undefined): void {
  installed = apps
}

/** The installed record, for the one caller that writes it. */
export function localFileApps (): LocalFileApps | undefined {
  return installed
}

/** Whether `key` was allowed to use Orivon permissions. False for everything before a record is installed. */
export function isRecordedLocalFile (key: string): boolean {
  return installed?.has(key) === true
}

/** Whether `path`, a file-system path, is a recorded file: what a download or a saved page must not be named after. */
export function isRecordedLocalPath (path: string): boolean {
  if (installed === undefined) return false
  const key = localFileKey(pathToFileURL(path).href)
  return key !== null && installed.has(key)
}
