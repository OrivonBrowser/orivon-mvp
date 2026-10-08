// The database's file calls: the app's files over the Worker's synchronous
// twin (fs/sync-orivon.ts), the same channel `fs.openSync` uses. Only vfs.ts
// calls this; it has no idea it serves a database.

import { refuseShim } from '../errors.js'
import { confineSync } from '../fs/paths.js'
import { guardedSync, syncFsWithOpen, type SyncFileHandleWire } from '../fs/sync-orivon.js'
import { VIRTUAL_TMPDIR } from '../virtual-root.js'

const API = 'sqlite.DatabaseSync'

export type SqliteOpenMode = 'read' | 'readwrite' | 'create' | 'create-exclusive'

export interface SqliteFile {
  read (position: number, length: number): Uint8Array
  write (position: number, data: Uint8Array): void
  size (): number
  truncate (length: number): void
  sync (): void
  close (): void
}

export interface SqliteFiles {
  open (path: string, mode: SqliteOpenMode): SqliteFile
  exists (path: string): boolean
  /** Throws an error whose `code` is `ENOENT` when there is no such file. */
  remove (path: string): void
  /** A path for a file SQLite wants only while it is open (`VACUUM`'s copy, a large sort). */
  temporaryPath (): string
}

function randomHex (bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function wrap (handle: SyncFileHandleWire): SqliteFile {
  return {
    read: (position, length) => guardedSync(() => handle.read({ position, length })),
    write: (position, data) => { guardedSync(() => handle.write({ position, data })) },
    size: () => guardedSync(() => handle.stat().size),
    truncate: (length) => { guardedSync(() => { handle.truncate(length) }) },
    sync: () => { guardedSync(() => { handle.sync() }) },
    close: () => { guardedSync(() => { handle.close() }) }
  }
}

/** The synchronous file calls, or a refusal that names why a database file cannot be opened here. `:memory:` never asks. */
export function orivonSqliteFiles (): SqliteFiles {
  let fs: ReturnType<typeof syncFsWithOpen>
  try {
    fs = syncFsWithOpen(API)
  } catch {
    throw refuseShim(API, 'not-built',
      'a database file needs synchronous file calls, which work only in a forked child or a worker_threads.Worker ' +
      "of a cross-origin isolated app, not on the page. ':memory:' works everywhere")
  }
  const confined = (path: string): string => confineSync(path, 'open', API)
  const exists = (path: string): boolean => {
    try {
      fs.stat(confined(path))
      return true
    } catch {
      return false
    }
  }
  return {
    open (path, mode) {
      const target = confined(path)
      if (mode === 'read') return wrap(guardedSync(() => fs.open(target, 'r')))
      if (mode === 'readwrite') return wrap(guardedSync(() => fs.open(target, 'r+')))
      // A file SQLite may create is opened for reading and writing without truncation: 'wx+' creates it, and 'r+' takes one that exists.
      try {
        return wrap(guardedSync(() => fs.open(target, 'wx+')))
      } catch (error) {
        if (mode === 'create-exclusive' || (error as { code?: string }).code !== 'EEXIST') throw error
      }
      return wrap(guardedSync(() => fs.open(target, 'r+')))
    },
    exists,
    remove: (path) => { guardedSync(() => { fs.rm(confined(path)) }) },
    temporaryPath: () => `${VIRTUAL_TMPDIR}/etilqs_${randomHex(16)}`
  }
}
