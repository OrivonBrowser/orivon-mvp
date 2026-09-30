// Reads another browser's database without touching it: the file and its write-ahead log are copied into a
// private temporary directory, the copy is opened read-only, and the directory is deleted afterwards. The other
// browser may be running and holding its file; it is never written to, locked or left with a stray file.
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ImportError } from './import-types.js'

/** A file another process holds open for its own use, which is how Windows reports a database in use. */
const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ETXTBSY'])

const codeOf = (error: unknown): string | undefined => (error as { code?: unknown } | null)?.code as string | undefined

async function copyOrThrow (from: string, to: string): Promise<void> {
  try {
    await copyFile(from, to)
  } catch (error) {
    throw new ImportError(BUSY_CODES.has(codeOf(error) ?? '') ? 'locked' : 'unreadable')
  }
}

/** Runs `use` over a read-only copy of the database at `path`. Throws `locked` when the file cannot be copied
 * because it is in use, and `unreadable` when it is missing, is not a database, or `use` fails on its shape. */
export async function withDatabaseCopy<T> (path: string, use: (db: DatabaseSync) => T, temp: string = tmpdir()): Promise<T> {
  // The directory is private to this process: mkdtemp creates it with mode 0700.
  const dir = await mkdtemp(join(temp, 'orivon-import-'))
  try {
    const target = join(dir, basename(path))
    await copyOrThrow(path, target)
    // A write-ahead log holds the pages a running browser has not yet folded into the file; without it the copy would be behind.
    await copyFile(`${path}-wal`, `${target}-wal`).catch((error: unknown) => {
      if (codeOf(error) !== 'ENOENT') throw new ImportError(BUSY_CODES.has(codeOf(error) ?? '') ? 'locked' : 'unreadable')
    })
    let db: DatabaseSync
    try {
      db = new DatabaseSync(target, { readOnly: true })
    } catch {
      throw new ImportError('unreadable')
    }
    try {
      return use(db)
    } catch (error) {
      throw error instanceof ImportError ? error : new ImportError('unreadable')
    } finally {
      db.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
