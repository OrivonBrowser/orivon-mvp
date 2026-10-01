// Reads another browser's database without touching it: the file and its write-ahead log are copied into a
// private temporary directory, the copy is opened read-only, and the directory is deleted afterwards. The other
// browser may be running and holding its file; it is never written to, locked or left with a stray file.
import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ImportError } from './import-types.js'

/** A file another process holds open for its own use, which is how Windows reports a database in use. */
const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ETXTBSY'])

/** A source database larger than this is not read: the copy would take that much disk and time, and the machine may keep temporary files in memory. */
export const MAX_DATABASE_BYTES = 1024 * 1024 * 1024

const codeOf = (error: unknown): string | undefined => (error as { code?: unknown } | null)?.code as string | undefined

async function copyOrThrow (from: string, to: string): Promise<void> {
  try {
    await copyFile(from, to)
  } catch (error) {
    throw new ImportError(BUSY_CODES.has(codeOf(error) ?? '') ? 'locked' : 'unreadable')
  }
}

/** Runs `use` over a read-only copy of the database at `path`. Throws `locked` when the file cannot be copied
 * because it is in use, and `unreadable` when it is missing, is too large, is not a database, or `use` fails on its shape.
 * The file and its log are copied one after the other while their browser may be running, so a copy made across one of its
 * checkpoints can be out of step with itself: a read that fails is tried once more on a fresh copy. */
export async function withDatabaseCopy<T> (path: string, use: (db: DatabaseSync) => T, temp: string = tmpdir()): Promise<T> {
  const size = await stat(path).then((info) => info.size, () => undefined)
  if (size !== undefined && size > MAX_DATABASE_BYTES) throw new ImportError('unreadable')
  try {
    return await readCopy(path, use, temp)
  } catch (error) {
    if (!(error instanceof ImportError) || error.reason !== 'unreadable') throw error
    return await readCopy(path, use, temp)
  }
}

async function readCopy<T> (path: string, use: (db: DatabaseSync) => T, temp: string): Promise<T> {
  // The directory is private to this process: mkdtemp creates it with mode 0700, inside a folder of the same mode.
  await mkdir(temp, { recursive: true, mode: 0o700 })
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
