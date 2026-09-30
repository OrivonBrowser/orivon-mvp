// A database in a file of the app's files, over the memory-backed synchronous
// file twin: durability, the rollback journal, recovery, VACUUM, and a
// database far larger than the page cache.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from '../database.js'
import { createMemorySyncFs, type MemorySyncFs } from './support/memory-sync-fs.js'
import { loadTestEngine } from './support/engine.js'

const DB = '/orivon/app/data/messages.sqlite3'
const FILE = 'data/messages.sqlite3'
const JOURNAL = `${FILE}-journal`

let fs: MemorySyncFs

beforeAll(loadTestEngine)
beforeEach(() => { fs = createMemorySyncFs(); fs.install() })
afterEach(() => { fs.uninstall() })

function count (db: DatabaseSync, table = 't'): number {
  return (db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n
}

function fill (db: DatabaseSync, rows: number, payload = 200): void {
  db.exec('create table if not exists t (id integer primary key, body text)')
  const insert = db.prepare('insert into t (body) values (?)')
  db.exec('begin')
  for (let i = 0; i < rows; i++) insert.run('x'.repeat(payload) + String(i))
  db.exec('commit')
}

describe('opening', () => {
  it('a file database off the isolated Worker refuses by name, and :memory: still works', () => {
    fs.uninstall()
    expect(() => new DatabaseSync(DB)).toThrow(expect.objectContaining({
      name: 'OrivonShimError', reason: 'not-built', message: expect.stringContaining('cross-origin isolated') as string
    }))
    expect(new DatabaseSync(':memory:').prepare('select 1 as x').get()).toEqual({ x: 1 })
  })

  it(':memory: makes no file call', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('create table t (x); insert into t values (1)')
    db.close()
    expect(fs.calls).toEqual([])
  })

  it('creates the file, and reopens what was committed', () => {
    const db = new DatabaseSync(DB)
    fill(db, 20)
    db.close()
    expect(fs.files.has(FILE)).toBe(true)
    expect(fs.files.has(JOURNAL)).toBe(false)
    const again = new DatabaseSync(DB)
    expect(count(again)).toBe(20)
    expect(again.location()).toBe(DB)
    again.close()
  })

  it('a relative path is the same file', () => {
    const db = new DatabaseSync('data/messages.sqlite3')
    db.exec('create table t (x)')
    db.close()
    expect(fs.files.has(FILE)).toBe(true)
  })

  it('a read-only open of a missing file fails as Node\'s does', () => {
    expect(() => new DatabaseSync(DB, { readOnly: true })).toThrow(expect.objectContaining({
      code: 'ERR_SQLITE_ERROR', errcode: 14, message: 'unable to open database file'
    }))
  })

  it('a read-only connection reads and refuses to write', () => {
    const db = new DatabaseSync(DB)
    fill(db, 3)
    db.close()
    const readOnly = new DatabaseSync(DB, { readOnly: true })
    expect(count(readOnly)).toBe(3)
    expect(() => readOnly.exec('insert into t (body) values (1)')).toThrow(expect.objectContaining({ code: 'ERR_SQLITE_ERROR', errcode: 8 }))
    readOnly.close()
  })

  it('closing releases every file handle', () => {
    const db = new DatabaseSync(DB)
    fill(db, 3)
    db.close()
    const opens = fs.calls.filter((call) => call.startsWith('open:')).length
    expect(fs.calls.filter((call) => call === 'close').length).toBe(opens)
  })

  it('WAL needs shared memory and stays off', () => {
    const db = new DatabaseSync(DB)
    expect(db.prepare('pragma journal_mode = wal').get()).toEqual({ journal_mode: 'delete' })
    db.close()
  })
})

describe('the rollback journal', () => {
  it('is a real file beside the database while a transaction has changes, and gone after COMMIT', () => {
    const db = new DatabaseSync(DB)
    db.exec('create table t (id integer primary key, body text)')
    db.exec('begin')
    db.exec("insert into t (body) values ('a')")
    db.exec('pragma cache_size = 1')
    for (let i = 0; i < 40; i++) db.exec(`insert into t (body) values ('${'y'.repeat(400)}')`)
    expect(fs.files.has(JOURNAL)).toBe(true)
    db.exec('commit')
    expect(fs.files.has(JOURNAL)).toBe(false)
    db.close()
  })

  it('a rollback leaves the file exactly as it was', () => {
    const db = new DatabaseSync(DB)
    fill(db, 30)
    const before = fs.contents(FILE)
    db.exec('pragma cache_size = 4')
    fs.calls.length = 0
    db.exec('begin')
    const insert = db.prepare('insert into t (body) values (?)')
    for (let i = 0; i < 400; i++) insert.run('z'.repeat(300))
    // Only a spill of modified pages out of the cache syncs the journal before the commit.
    expect(fs.calls).toContain('sync')
    db.exec('rollback')
    expect(fs.contents(FILE)).toEqual(before)
    expect(fs.files.has(JOURNAL)).toBe(false)
    expect(count(db)).toBe(30)
    db.close()
  })

  it('a failed statement inside a transaction leaves the earlier ones', () => {
    const db = new DatabaseSync(DB)
    db.exec('create table u (k text unique)')
    db.exec('begin')
    db.prepare('insert into u values (?)').run('a')
    expect(() => db.prepare('insert into u values (?)').run('a')).toThrow(expect.objectContaining({ errcode: 2067 }))
    db.exec('commit')
    expect(count(db, 'u')).toBe(1)
    db.close()
  })
})

describe('a crash at any file call of a commit', () => {
  it('leaves the old state or the new one, never a mix', () => {
    const db = new DatabaseSync(DB)
    fill(db, 40)
    db.exec('pragma cache_size = 4')
    const points: Array<Map<string, { bytes: Uint8Array, length: number }>> = []
    fs.hook = () => { points.push(fs.snapshot()) }
    fill(db, 300, 300)
    fs.hook = () => {}
    points.push(fs.snapshot())
    db.close()
    expect(points.length).toBeGreaterThan(12)
    const seen = new Set<number>()
    for (const point of points) {
      fs.restore(point)
      const recovered = new DatabaseSync(DB)
      expect(recovered.prepare('pragma integrity_check').get()).toEqual({ integrity_check: 'ok' })
      seen.add(count(recovered))
      recovered.close()
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([40, 340])
  })
})

describe('VACUUM', () => {
  it('shrinks the file, keeps the data and leaves no temporary file', () => {
    const db = new DatabaseSync(DB)
    fill(db, 300)
    const full = fs.files.get(FILE)?.length ?? 0
    db.exec('delete from t where id % 10 != 0')
    db.exec('vacuum')
    const shrunk = fs.files.get(FILE)?.length ?? 0
    expect(shrunk).toBeLessThan(full / 4)
    expect(count(db)).toBe(30)
    expect(db.prepare('pragma integrity_check').get()).toEqual({ integrity_check: 'ok' })
    db.close()
    expect([...fs.files.keys()]).toEqual([FILE])
  })
})

describe('a database larger than the page cache', () => {
  it('reads and writes through a small cache, and survives a reopen', () => {
    const db = new DatabaseSync(DB)
    db.exec('pragma cache_size = 8')
    fill(db, 3000, 500)
    db.exec('create index t_body on t (body)')
    expect((fs.files.get(FILE)?.length ?? 0)).toBeGreaterThan(1_500_000)
    expect(db.prepare('select body from t where id = 2500').get()).toEqual({ body: `${'x'.repeat(500)}2499` })
    db.prepare('update t set body = ? where id = 10').run('changed')
    db.close()
    const again = new DatabaseSync(DB)
    expect(count(again)).toBe(3000)
    expect(again.prepare('select body from t where id = 10').get()).toEqual({ body: 'changed' })
    expect(again.prepare('select count(*) as n from t where body > ?').get('x'.repeat(500) + '2')).toEqual({ n: expect.any(Number) as number })
    expect(again.prepare('pragma integrity_check').get()).toEqual({ integrity_check: 'ok' })
    again.close()
  })

  it('a VACUUM that spills with file temporary storage uses a temporary file, and removes it', () => {
    const db = new DatabaseSync(DB)
    fill(db, 500, 400)
    db.exec('pragma temp_store = file; pragma cache_size = 4')
    fs.calls.length = 0
    db.exec('vacuum')
    expect(fs.calls.some((call) => call.startsWith('open:tmp/etilqs_'))).toBe(true)
    db.close()
    expect([...fs.files.keys()]).toEqual([FILE])
  })

  it('a commit writes the pages it changed, never the whole file', () => {
    const db = new DatabaseSync(DB)
    fill(db, 2000, 500)
    const size = fs.files.get(FILE)?.length ?? 0
    fs.bytesWritten = 0
    db.prepare('insert into t (body) values (?)').run('one more')
    expect(size).toBeGreaterThan(1_000_000)
    expect(fs.bytesWritten).toBeLessThan(64 * 1024)
    db.close()
  })
})
