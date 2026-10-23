// `better-sqlite3`'s Database#backup over the shim: a consistent copy of an open
// database lands in one of the app's files, replaces what was there whole, and
// goes nowhere else.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from '../better-sqlite3.js'
import { loadTestEngine } from './support/engine.js'
import { createMemorySyncFs, type MemorySyncFs } from './support/memory-sync-fs.js'

const SOURCE = '/orivon/app/data/main.sqlite3'
const COPY = '/orivon/app/backups/copy.sqlite3'

let fs: MemorySyncFs

beforeAll(loadTestEngine)
beforeEach(() => {
  fs = createMemorySyncFs()
  fs.install()
  fs.files.set('backups/keep.txt', { bytes: new Uint8Array([1]), length: 1 })
})
afterEach(() => { fs.uninstall() })

function filled (path = SOURCE, rows = 50): InstanceType<typeof Database> {
  const db = new Database(path)
  db.exec('create table t (id integer primary key, body text); create index t_body on t (body)')
  db.pragma('user_version = 7')
  db.pragma('application_id = 1234')
  const insert = db.prepare('insert into t (body) values (?)')
  db.transaction(() => { for (let i = 0; i < rows; i++) insert.run(`row ${String(i)} ${'x'.repeat(300)}`) })()
  return db
}

const counted = (path: string): number => {
  const copy = new Database(path, { readonly: true })
  try { return copy.prepare('select count(*) from t').pluck().get() as number } finally { copy.close() }
}

describe('the copy', () => {
  it('resolves with the page counts once a database that opens and passes its check is in place', async () => {
    const db = filled()
    const info = await db.backup(COPY)
    expect(info.remainingPages).toBe(0)
    expect(info.totalPages).toBeGreaterThan(3)
    expect(counted(COPY)).toBe(50)
    const copy = new Database(COPY)
    expect(copy.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(copy.pragma('user_version', { simple: true })).toBe(7)
    expect(copy.pragma('application_id', { simple: true })).toBe(1234)
    expect(copy.prepare("select name from sqlite_master where type = 'index'").pluck().all()).toContain('t_body')
    expect(copy.pragma('page_size', { simple: true })).toBe(db.pragma('page_size', { simple: true }))
    copy.close()
  })

  it('leaves the source as it was, and usable', async () => {
    const db = filled()
    const before = fs.contents('data/main.sqlite3')
    await db.backup(COPY)
    expect(fs.contents('data/main.sqlite3')).toEqual(before)
    db.prepare('insert into t (body) values (?)').run('after')
    expect(db.prepare('select count(*) from t').pluck().get()).toBe(51)
    expect(counted(COPY)).toBe(50)
  })

  it('is a snapshot of what was committed when it was asked for', async () => {
    const db = filled()
    const done = db.backup(COPY)
    db.prepare('insert into t (body) values (?)').run('later')
    await done
    expect(counted(COPY)).toBe(50)
  })

  it('replaces a file that was there, whole', async () => {
    const small = filled('/orivon/app/backups/old.sqlite3', 2)
    small.close()
    const db = filled()
    await db.backup('/orivon/app/backups/old.sqlite3')
    expect(counted('/orivon/app/backups/old.sqlite3')).toBe(50)
  })

  it('leaves no other file beside it', async () => {
    const db = filled()
    await db.backup(COPY)
    expect([...fs.files.keys()].sort()).toEqual(['backups/copy.sqlite3', 'backups/keep.txt', 'data/main.sqlite3'])
  })

  it('copies an in-memory database to a file', async () => {
    const memory = new Database(':memory:')
    memory.exec('create table t (id integer primary key, body text); insert into t (body) values (\'a\'), (\'b\')')
    await memory.backup(COPY)
    expect(counted(COPY)).toBe(2)
  })

  it('copies a database opened read-only', async () => {
    filled().close()
    const readonly = new Database(SOURCE, { readonly: true })
    await readonly.backup(COPY)
    expect(counted(COPY)).toBe(50)
  })

  it('copies an attached database, named by the attached option', async () => {
    const db = new Database(':memory:')
    db.exec("attach database ':memory:' as other; create table other.t (id integer primary key, body text); insert into other.t (body) values ('x'), ('y'), ('z')")
    await db.backup(COPY, { attached: 'other' })
    expect(counted(COPY)).toBe(3)
  })

  it('takes a path with a quote in it, and a relative one', async () => {
    const db = filled()
    await db.backup("/orivon/app/backups/it's.sqlite3")
    await db.backup('backups/relative.sqlite3')
    expect(counted("/orivon/app/backups/it's.sqlite3")).toBe(50)
    expect(counted('backups/relative.sqlite3')).toBe(50)
  })

  it('calls the progress option with the page counts when the copy is done', async () => {
    const db = filled()
    const progress = vi.fn()
    const info = await db.backup(COPY, { progress })
    expect(progress).toHaveBeenCalledTimes(1)
    expect(progress).toHaveBeenCalledWith(info)
  })
})

describe('a copy that cannot be made', () => {
  const rejected = async (run: () => Promise<unknown>): Promise<unknown> => {
    try { await run() } catch (error) { return error }
    return undefined
  }

  it('inside a transaction leaves the destination, and the files, as they were', async () => {
    const old = filled('/orivon/app/backups/old.sqlite3', 2)
    old.close()
    const before = fs.contents('backups/old.sqlite3')
    const db = filled()
    db.exec('begin')
    db.prepare('insert into t (body) values (?)').run('pending')
    expect(await rejected(async () => await db.backup('/orivon/app/backups/old.sqlite3'))).toMatchObject({ name: 'SqliteError', message: 'cannot back up a database from within a transaction' })
    expect(fs.contents('backups/old.sqlite3')).toEqual(before)
    expect([...fs.files.keys()].sort()).toEqual(['backups/keep.txt', 'backups/old.sqlite3', 'data/main.sqlite3', 'data/main.sqlite3-journal'].filter((key) => fs.files.has(key)))
    db.exec('rollback')
    await db.backup(COPY)
    expect(counted(COPY)).toBe(50)
  })

  it('of an attached database that does not exist rejects with the engine\'s error', async () => {
    const db = filled()
    expect(await rejected(async () => await db.backup(COPY, { attached: 'nowhere' }))).toMatchObject({ name: 'SqliteError', message: 'unknown database "nowhere"' })
    expect(fs.files.has('backups/copy.sqlite3')).toBe(false)
  })

  it('over the database it is copying is refused', async () => {
    const db = filled()
    const before = fs.contents('data/main.sqlite3')
    expect(await rejected(async () => await db.backup(SOURCE))).toEqual(new TypeError('Cannot save backup over the database it is copying'))
    expect(await rejected(async () => await db.backup('data/main.sqlite3'))).toEqual(new TypeError('Cannot save backup over the database it is copying'))
    expect(fs.contents('data/main.sqlite3')).toEqual(before)
  })

  it('from a closed database is refused', async () => {
    const db = filled()
    db.close()
    expect(await rejected(async () => await db.backup(COPY))).toEqual(new TypeError('The database connection is not open'))
  })

  it('checks its arguments with better-sqlite3\'s messages, as a rejection', async () => {
    const db = filled()
    const backup = db.backup.bind(db) as (...args: unknown[]) => Promise<unknown>
    expect(await rejected(async () => await backup(5))).toEqual(new TypeError('Expected first argument to be a string'))
    expect(await rejected(async () => await backup(COPY, 5))).toEqual(new TypeError('Expected second argument to be an options object'))
    expect(await rejected(async () => await backup('   '))).toEqual(new TypeError('Backup filename cannot be an empty string'))
    expect(await rejected(async () => await backup(':memory:'))).toEqual(new TypeError('Invalid backup filename ":memory:"'))
    expect(await rejected(async () => await backup(COPY, { attached: 5 }))).toEqual(new TypeError('Expected the "attached" option to be a string'))
    expect(await rejected(async () => await backup(COPY, { attached: '' }))).toEqual(new TypeError('The "attached" option cannot be an empty string'))
    expect(await rejected(async () => await backup(COPY, { progress: 5 }))).toEqual(new TypeError('Expected the "progress" option to be a function'))
    expect(await rejected(async () => await backup('/orivon/app/missing/copy.sqlite3'))).toEqual(new TypeError('Cannot save backup because the directory does not exist'))
  })

  it('to a place outside the app\'s files writes nothing anywhere', async () => {
    const db = filled()
    const before = [...fs.files.keys()].sort()
    for (const outside of ['../escape.sqlite3', '/etc/escape.sqlite3', 'backups/../../escape.sqlite3', '/orivon/app/../escape.sqlite3']) {
      expect(await rejected(async () => await db.backup(outside)), outside).toBeInstanceOf(Error)
    }
    expect([...fs.files.keys()].sort()).toEqual(before)
    expect(fs.calls.filter((call) => /escape/.test(call) && !call.startsWith('stat'))).toEqual([])
  })

  it('off the isolated Worker refuses by name', async () => {
    const db = new Database(':memory:')
    fs.uninstall()
    expect(await rejected(async () => await db.backup(COPY))).toMatchObject({ name: 'OrivonShimError', reason: 'not-built' })
  })
})
