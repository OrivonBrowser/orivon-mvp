import { readdirSync, statSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ImportError } from '../import-types.js'
import { MAX_DATABASE_BYTES, withDatabaseCopy } from '../sqlite-copy.js'
import { makeChromeHistory } from './databases.js'

let dir = ''
let temp = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orivon-copy-test-'))
  temp = await mkdtemp(join(tmpdir(), 'orivon-copy-temp-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(temp, { recursive: true, force: true })
})

const count = (db: { prepare: (sql: string) => { get: () => unknown } }): number => (db.prepare('SELECT COUNT(*) AS n FROM urls').get() as { n: number }).n

describe('withDatabaseCopy', () => {
  it('reads rows that are still in the write-ahead log, which a plain copy of the file would miss', async () => {
    const path = join(dir, 'History')
    const live = makeChromeHistory(path, [{ url: 'https://a.test/', title: 'A', visits: 1, at: 1_700_000_000_000 }, { url: 'https://b.test/', title: 'B', visits: 2, at: 1_700_000_001_000 }])
    try {
      const folded = await stat(path)
      expect((await readdir(dir)).sort()).toEqual(['History', 'History-shm', 'History-wal'])
      expect(folded.size).toBeLessThan(40_000)
      expect(await withDatabaseCopy(path, count, temp)).toBe(2)
      // Without the log the file alone holds no table at all: the rows exist only in the log.
      const bare = join(dir, 'bare', 'History')
      await mkdir(join(dir, 'bare'))
      await copyFile(path, bare)
      await expect(withDatabaseCopy(bare, count, temp)).rejects.toThrowError(expect.objectContaining({ reason: 'unreadable' }))
    } finally {
      live.close()
    }
  })

  it('never writes to the original: its files are exactly as they were, and it leaves no file beside them', async () => {
    const path = join(dir, 'History')
    const live = makeChromeHistory(path, [{ url: 'https://a.test/', title: 'A', visits: 1, at: 1_700_000_000_000 }])
    try {
      const before = await Promise.all((await readdir(dir)).sort().map(async (name) => `${name}:${String((await stat(join(dir, name))).size)}:${String((await stat(join(dir, name))).mtimeMs)}`))
      await withDatabaseCopy(path, count, temp)
      const after = await Promise.all((await readdir(dir)).sort().map(async (name) => `${name}:${String((await stat(join(dir, name))).size)}:${String((await stat(join(dir, name))).mtimeMs)}`))
      expect(after).toEqual(before)
    } finally {
      live.close()
    }
  })

  it('deletes its temporary directory afterwards, also when reading fails', async () => {
    const path = join(dir, 'History')
    makeChromeHistory(path, [], { wal: false }).close()
    await withDatabaseCopy(path, count, temp)
    expect(await readdir(temp)).toEqual([])
    await expect(withDatabaseCopy(path, () => { throw new Error('boom') }, temp)).rejects.toThrowError(expect.objectContaining({ reason: 'unreadable' }))
    expect(await readdir(temp)).toEqual([])
  })

  it('makes the directory private to its owner', async () => {
    const path = join(dir, 'History')
    makeChromeHistory(path, [], { wal: false }).close()
    const modes = await withDatabaseCopy(path, () => readdirSync(temp).map((name) => statSync(join(temp, name)).mode & 0o777), temp)
    expect(modes).toHaveLength(1)
    if (process.platform !== 'win32') expect(modes[0]).toBe(0o700)
  })

  it('maps a missing file, a file that is not a database and a query the file cannot answer to unreadable', async () => {
    await expect(withDatabaseCopy(join(dir, 'missing'), count, temp)).rejects.toThrowError(expect.objectContaining({ reason: 'unreadable' }))
    const junk = join(dir, 'junk')
    await writeFile(junk, 'this is not a database at all, but long enough to be read as a header '.repeat(20))
    await expect(withDatabaseCopy(junk, count, temp)).rejects.toThrow(ImportError)
    const path = join(dir, 'History')
    makeChromeHistory(path, [], { wal: false }).close()
    await expect(withDatabaseCopy(path, (db) => db.prepare('SELECT nothing FROM urls').all(), temp)).rejects.toThrowError(expect.objectContaining({ reason: 'unreadable' }))
  })

  it('makes the folder it copies into when that does not exist yet, private to its owner', async () => {
    const path = join(dir, 'History')
    makeChromeHistory(path, [], { wal: false }).close()
    const nested = join(temp, 'import-tmp')
    await withDatabaseCopy(path, count, nested)
    expect(await readdir(nested)).toEqual([])
    if (process.platform !== 'win32') expect((await stat(nested)).mode & 0o777).toBe(0o700)
  })

  it('refuses a database larger than the limit, without copying any of it', async () => {
    const path = join(dir, 'History')
    await writeFile(path, '')
    await truncate(path, MAX_DATABASE_BYTES + 1)
    await expect(withDatabaseCopy(path, count, temp)).rejects.toThrowError(expect.objectContaining({ reason: 'unreadable' }))
    expect(await readdir(temp)).toEqual([])
  })

  it('reads again from a fresh copy when the first read fails, as it can across the other browser\'s checkpoint', async () => {
    const path = join(dir, 'History')
    makeChromeHistory(path, [], { wal: false }).close()
    let attempts = 0
    const rows = await withDatabaseCopy(path, (db) => { attempts += 1; if (attempts === 1) throw new Error('out of step'); return count(db) }, temp)
    expect(rows).toBe(0)
    expect(attempts).toBe(2)
    attempts = 0
    await expect(withDatabaseCopy(path, () => { attempts += 1; throw new Error('always') }, temp)).rejects.toThrowError(expect.objectContaining({ reason: 'unreadable' }))
    expect(attempts).toBe(2)
  })

  it('maps a file that cannot be opened because something holds it to locked', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return
    const path = join(dir, 'History')
    makeChromeHistory(path, [], { wal: false }).close()
    await chmod(path, 0o000)
    try {
      await expect(withDatabaseCopy(path, count, temp)).rejects.toThrowError(expect.objectContaining({ reason: 'locked' }))
    } finally {
      await chmod(path, 0o600)
    }
  })
})
