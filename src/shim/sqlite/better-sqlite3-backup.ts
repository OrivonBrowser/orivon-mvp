// `better-sqlite3`'s `Database#backup`, as a copy written to a file beside the
// destination and renamed over it (README.md, Design notes says why).

import { exportDatabase, type DatabaseSync } from './database.js'
import { orivonSqliteFiles, type SqliteFiles } from './files.js'
import { guarded, notOpen, SqliteError } from './better-sqlite3-errors.js'

export interface BackupInfo {
  readonly totalPages: number
  readonly remainingPages: number
}

interface Checked {
  readonly destination: string
  readonly attached: string
  readonly progress: ((info: BackupInfo) => unknown) | null
}

/** The arguments of `backup(destination, options)` as `better-sqlite3` checks them, with its messages. */
function checked (destination: unknown, options: unknown): Checked {
  if (typeof destination !== 'string') throw new TypeError('Expected first argument to be a string')
  if (options !== undefined && options !== null && typeof options !== 'object') throw new TypeError('Expected second argument to be an options object')
  const settings = (options ?? {}) as { attached?: unknown, progress?: unknown }
  const attached = 'attached' in settings ? settings.attached : 'main'
  const progress = 'progress' in settings ? settings.progress : null
  const path = destination.trim()
  if (path === '') throw new TypeError('Backup filename cannot be an empty string')
  if (path === ':memory:') throw new TypeError('Invalid backup filename ":memory:"')
  if (path.includes('\0')) throw new TypeError('Backup filename cannot contain a null byte')
  if (typeof attached !== 'string') throw new TypeError('Expected the "attached" option to be a string')
  if (attached === '') throw new TypeError('The "attached" option cannot be an empty string')
  if (progress !== null && progress !== undefined && typeof progress !== 'function') throw new TypeError('Expected the "progress" option to be a function')
  return { destination: path, attached, progress: (progress ?? null) as Checked['progress'] }
}

function directoryOf (path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : slash === 0 ? '/' : path.slice(0, slash)
}

function randomName (): string {
  return [...crypto.getRandomValues(new Uint8Array(6))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** A destination that is one of the files the source database is using would be overwritten by the copy of itself. */
function refuseOwnFile (files: SqliteFiles, source: DatabaseSync, attached: string, destination: string): void {
  for (const schema of new Set(['main', attached])) {
    let location: string | null
    try {
      location = source.location(schema)
    } catch {
      continue
    }
    if (location === null) continue
    if (files.isSameFile(location, destination) || files.isSameFile(`${location}-journal`, destination)) {
      throw new TypeError('Cannot save backup over the database it is copying')
    }
  }
}

const schemaIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`

/** Writes the database `attached` of `source` to `copy`: `VACUUM INTO` for a file, whose own VFS then writes it, and the engine's export for a database in memory, which that VFS does not serve. */
function writeCopy (files: SqliteFiles, source: DatabaseSync, attached: string, copy: string): void {
  if (source.location(attached) !== null) {
    guarded(() => { source.prepare(`VACUUM ${schemaIdentifier(attached)} INTO ?`).run(copy) })
    return
  }
  const bytes = exportDatabase(source, attached)
  const file = files.open(copy, 'create-exclusive')
  try {
    file.write(0, bytes)
    file.sync()
  } finally {
    file.close()
  }
}

/**
 * A copy of the committed database `attached` of `source`, written to `destination` in one step: a file
 * beside it receives the copy and replaces `destination`, so a failure leaves `destination` as it was.
 * It resolves after the copy is in place, with the page counts `better-sqlite3` reports.
 */
export async function backupDatabase (source: DatabaseSync, destination: unknown, options: unknown): Promise<BackupInfo> {
  const request = checked(destination, options)
  const files = orivonSqliteFiles()
  const directory = directoryOf(request.destination)
  if (directory !== '' && !files.exists(directory)) throw new TypeError('Cannot save backup because the directory does not exist')
  if (!source.isOpen) throw notOpen()
  refuseOwnFile(files, source, request.attached, request.destination)
  if (source.isTransaction) throw new SqliteError('cannot back up a database from within a transaction', 'SQLITE_ERROR')
  const pageSize = Number((guarded(() => source.prepare(`PRAGMA ${schemaIdentifier(request.attached)}.page_size`).get()) as { page_size: number }).page_size)
  const copy = `${request.destination}.backup-${randomName()}`
  try {
    writeCopy(files, source, request.attached, copy)
    const info = { totalPages: Math.ceil(files.size(copy) / pageSize), remainingPages: 0 }
    files.rename(copy, request.destination)
    request.progress?.(info)
    return info
  } catch (error) {
    try { files.remove(copy) } catch { /* the copy was never made, or is gone */ }
    throw error
  }
}
