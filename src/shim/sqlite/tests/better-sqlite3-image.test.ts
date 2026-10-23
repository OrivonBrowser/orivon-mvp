// `better-sqlite3`'s `new Database(buffer)` and `db.serialize()` over the shim: a
// database opens from the bytes of its file, lives in the engine's memory alone,
// and serializes back to the bytes of a file.

import { Buffer as ShimBuffer } from 'buffer'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync as NodeDatabaseSync } from 'node:sqlite'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import Database, { SqliteError } from '../better-sqlite3.js'
import { sqliteEngine } from '../engine.js'
import { loadTestEngine } from './support/engine.js'
import { createMemorySyncFs, type MemorySyncFs } from './support/memory-sync-fs.js'

const FILE = '/orivon/app/data/main.sqlite3'
const HEADER = 'SQLite format 3\0'

let fs: MemorySyncFs

beforeAll(loadTestEngine)
beforeEach(() => {
  fs = createMemorySyncFs()
  fs.install()
})
afterEach(() => { fs.uninstall() })

function filled (path: string, rows = 40): InstanceType<typeof Database> {
  const db = new Database(path)
  db.exec('create table t (id integer primary key, body text); create index t_body on t (body)')
  db.pragma('user_version = 7')
  const insert = db.prepare('insert into t (body) values (?)')
  db.transaction(() => { for (let i = 0; i < rows; i++) insert.run(`row ${String(i)} ${'x'.repeat(200)}`) })()
  return db
}

/** The bytes of a database file made on disk by Node's own `node:sqlite`. */
function nodeImage (build: (db: NodeDatabaseSync) => void): Buffer {
  const directory = mkdtempSync(join(tmpdir(), 'orivon-image-'))
  try {
    const db = new NodeDatabaseSync(join(directory, 'x.db'))
    build(db)
    db.close()
    return readFileSync(join(directory, 'x.db'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const count = (db: InstanceType<typeof Database>): number => db.prepare('select count(*) from t').pluck().get() as number

describe('new Database(buffer)', () => {
  it('opens the bytes of a database file as a database in memory, named :memory:', () => {
    filled(FILE, 25).close()
    const image = Buffer.from(fs.contents('data/main.sqlite3') as Uint8Array)
    expect(image.subarray(0, 16).toString('latin1')).toBe(HEADER)
    const db = new Database(image)
    expect(db.name).toBe(':memory:')
    expect(db.memory).toBe(true)
    expect(db.readonly).toBe(false)
    expect(db.open).toBe(true)
    expect(count(db)).toBe(25)
    expect(db.pragma('user_version', { simple: true })).toBe(7)
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(db.prepare("select name from sqlite_master where type = 'index'").pluck().all()).toEqual(['t_body'])
    expect(db.prepare('select body from t where id = 3').pluck().get()).toBe(`row 2 ${'x'.repeat(200)}`)
  })

  it('takes a plain Uint8Array and a view into a larger buffer', () => {
    filled(FILE, 10).close()
    const image = fs.contents('data/main.sqlite3') as Uint8Array
    expect(count(new Database(image))).toBe(10)
    const padded = new Uint8Array(image.length + 100)
    padded.fill(0xee)
    padded.set(image, 37)
    expect(count(new Database(Buffer.from(padded.buffer, 37, image.length)))).toBe(10)
  })

  it('reads and writes the copy: the buffer given is not kept, changed, or written through', () => {
    filled(FILE, 10).close()
    const image = Buffer.from(fs.contents('data/main.sqlite3') as Uint8Array)
    const before = Buffer.from(image)
    const db = new Database(image)
    db.prepare('delete from t where id > 4').run()
    db.prepare('insert into t (body) values (?)').run('new')
    expect(count(db)).toBe(5)
    expect(image.equals(before)).toBe(true)
    image.fill(0)
    expect(count(db)).toBe(5)
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
  })

  it('reaches no file: the app\'s files are untouched and no call is made', () => {
    filled(FILE, 10).close()
    const image = Buffer.from(fs.contents('data/main.sqlite3') as Uint8Array)
    const files = [...fs.files.keys()]
    const before = fs.contents('data/main.sqlite3')
    fs.calls.length = 0
    const db = new Database(image)
    db.exec('create table extra (x); insert into extra values (1)')
    db.prepare('delete from t').run()
    db.pragma('vacuum')
    db.exec('vacuum')
    db.close()
    expect(fs.calls).toEqual([])
    expect([...fs.files.keys()]).toEqual(files)
    expect(fs.contents('data/main.sqlite3')).toEqual(before)
  })

  it('opens where no file is served at all: on a page, with no synchronous file calls', () => {
    fs.uninstall()
    const db = new Database(new Database(':memory:').exec('create table t (id integer primary key, body text); insert into t (body) values (\'a\')').serialize())
    expect(count(db)).toBe(1)
    fs.install()
  })

  it('serves a database made by Node\'s own node:sqlite, with its pages, text and blobs', () => {
    const image = nodeImage((db) => {
      db.exec('pragma user_version = 3; create table t (id integer primary key, body text, raw blob, n real)')
      const insert = db.prepare('insert into t (body, raw, n) values (?, ?, ?)')
      db.exec('begin')
      for (let i = 0; i < 300; i++) insert.run(`café ${String(i)}`, new Uint8Array([i % 256, 1, 2, 3]), i / 7)
      db.exec('commit')
    })
    const db = new Database(image)
    expect(count(db)).toBe(300)
    expect(db.pragma('user_version', { simple: true })).toBe(3)
    expect(db.prepare('select body, raw, n from t where id = 200').get()).toEqual({ body: 'café 199', raw: new Uint8Array([199, 1, 2, 3]), n: 199 / 7 })
    expect(db.pragma('page_size', { simple: true })).toBe(4096)
  })

  it('is readonly with the option: reads work, a write fails with SQLITE_READONLY', () => {
    filled(FILE, 6).close()
    const db = new Database(fs.contents('data/main.sqlite3') as Uint8Array, { readonly: true })
    expect(db.readonly).toBe(true)
    expect(count(db)).toBe(6)
    let caught: unknown
    try { db.prepare('insert into t (body) values (?)').run('x') } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(SqliteError)
    expect(caught).toMatchObject({ code: 'SQLITE_READONLY', message: 'attempt to write a readonly database' })
    expect(count(db)).toBe(6)
  })

  it('is writable by default and grows past the bytes it was given', () => {
    filled(FILE, 4).close()
    const image = fs.contents('data/main.sqlite3') as Uint8Array
    const db = new Database(image)
    db.exec("insert into t (body) select hex(randomblob(500)) from (with recursive c(i) as (select 1 union all select i + 1 from c where i < 600) select i from c)")
    expect(count(db)).toBe(604)
    expect(db.serialize().length).toBeGreaterThan(image.length * 10)
  })

  it('takes a database with no rows, and an empty buffer as an empty database', () => {
    const empty = new Database(Buffer.alloc(0))
    expect(empty.prepare('select count(*) from sqlite_master').pluck().get()).toBe(0)
    empty.exec('create table t (a); insert into t values (1)')
    expect(empty.prepare('select a from t').pluck().get()).toBe(1)
    expect(new Database(Buffer.alloc(0), { readonly: true }).prepare('select count(*) from sqlite_master').pluck().get()).toBe(0)
  })

  it('opens bytes that are not a database, and the first statement fails as a file would', () => {
    for (const bytes of [Buffer.from('this is not a database '.repeat(100)), Buffer.alloc(8192, 7), Buffer.from('SQLite format 3\0 and then nothing')]) {
      const db = new Database(bytes)
      let caught: unknown
      try { db.prepare('select 1 from sqlite_master') } catch (error) { caught = error }
      expect(caught).toBeInstanceOf(SqliteError)
      expect(caught).toMatchObject({ code: 'SQLITE_NOTADB', message: 'file is not a database' })
      db.close()
    }
  })

  it('does not vouch for a database cut short: the integrity check reports it', () => {
    filled(FILE, 40).close()
    const image = fs.contents('data/main.sqlite3') as Uint8Array
    const db = new Database(image.subarray(0, image.length - 2 * 8192))
    let verdict: unknown
    try { verdict = db.pragma('integrity_check', { simple: true }) } catch (error) { verdict = error }
    expect(verdict).not.toBe('ok')
  })

  it('checks its arguments with better-sqlite3\'s messages', () => {
    expect(() => new Database(new Uint16Array(4) as never)).toThrow(new TypeError('Expected first argument to be a string'))
    expect(() => new Database(new ArrayBuffer(8) as never)).toThrow(new TypeError('Expected first argument to be a string'))
    expect(() => new Database(Buffer.alloc(0), { readonly: 'yes' as never })).toThrow(new TypeError('Expected the "readonly" option to be a boolean'))
    expect(() => new Database(Buffer.alloc(0), { timeout: -1 })).toThrow(new TypeError('Expected the "timeout" option to be a positive integer'))
    expect(() => new Database(':memory:', { readonly: true })).toThrow(new TypeError('In-memory/temporary databases cannot be readonly'))
  })

  it('runs functions and backs itself up to a file, as a database from a path does', async () => {
    filled(FILE, 10).close()
    const db = new Database(fs.contents('data/main.sqlite3') as Uint8Array)
    db.function('twice', { deterministic: true }, (value: unknown) => (value as number) * 2)
    expect(db.prepare('select twice(id) from t where id = 4').pluck().get()).toBe(8)
    db.prepare('delete from t where id > 3').run()
    const info = await db.backup('/orivon/app/data/copy.sqlite3')
    expect(info.totalPages).toBe(db.pragma('page_count', { simple: true }))
    const copy = new Database('/orivon/app/data/copy.sqlite3', { readonly: true })
    expect(count(copy)).toBe(3)
    expect(copy.pragma('integrity_check', { simple: true })).toBe('ok')
    copy.close()
    expect(count(new Database(fs.contents('data/main.sqlite3') as Uint8Array))).toBe(10)
  })

  it('frees the engine\'s copy when the database closes', () => {
    filled(FILE, 200).close()
    const image = fs.contents('data/main.sqlite3') as Uint8Array
    expect(image.length).toBeGreaterThan(100_000)
    new Database(image).close()
    const heap = sqliteEngine().wasm.heap8u().length
    for (let i = 0; i < 300; i++) {
      const db = new Database(image)
      expect(count(db)).toBe(200)
      db.close()
    }
    expect(sqliteEngine().wasm.heap8u().length - heap).toBeLessThan(8 * 1024 * 1024)
  })

  it('frees the engine\'s copy of bytes that are no database as well', () => {
    const junk = Buffer.alloc(200_000, 9)
    new Database(junk).close()
    const heap = sqliteEngine().wasm.heap8u().length
    for (let i = 0; i < 300; i++) new Database(junk).close()
    expect(sqliteEngine().wasm.heap8u().length - heap).toBeLessThan(8 * 1024 * 1024)
  })

  it('opens a large image, tens of MiB, and gives the same bytes back', () => {
    const source = new Database(':memory:')
    source.exec('create table big (id integer primary key, b blob)')
    const insert = source.prepare('insert into big (b) values (zeroblob(?))')
    for (let i = 0; i < 44; i++) insert.run(1024 * 1024)
    const image = source.serialize()
    source.close()
    expect(image.length).toBeGreaterThan(40 * 1024 * 1024)
    const db = new Database(image)
    expect(db.prepare('select count(*), sum(length(b)) from big').raw().get()).toEqual([44, 44 * 1024 * 1024])
    db.prepare('delete from big where id > 40').run()
    expect(db.prepare('select count(*) from big').pluck().get()).toBe(40)
    expect(db.serialize().length).toBeLessThanOrEqual(image.length)
    db.close()
  })

  it('is closed like any database: statements then fail as on a closed database', () => {
    const db = new Database(Buffer.alloc(0))
    db.close()
    expect(db.open).toBe(false)
    expect(() => db.prepare('select 1')).toThrow(new TypeError('The database connection is not open'))
    expect(() => db.serialize()).toThrow(new TypeError('The database connection is not open'))
  })
})

describe('db.serialize()', () => {
  it('returns the bytes of the database as a file would hold them, in a Buffer', () => {
    const db = filled(':memory:', 30)
    const bytes = db.serialize()
    expect(ShimBuffer.isBuffer(bytes)).toBe(true)
    expect(bytes.subarray(0, 16).toString('latin1')).toBe(HEADER)
    expect(bytes.length).toBe((db.pragma('page_count', { simple: true }) as number) * (db.pragma('page_size', { simple: true }) as number))
    const again = new Database(bytes)
    expect(count(again)).toBe(30)
    expect(again.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(again.pragma('user_version', { simple: true })).toBe(7)
    expect(again.serialize().equals(bytes)).toBe(true)
  })

  it('returns a copy: changing the database or the bytes changes neither', () => {
    const db = filled(':memory:', 5)
    const bytes = db.serialize()
    const kept = ShimBuffer.from(bytes)
    db.prepare('insert into t (body) values (?)').run('later')
    expect(bytes.equals(kept)).toBe(true)
    bytes.fill(0)
    expect(count(db)).toBe(6)
    expect(db.serialize().subarray(0, 16).toString('latin1')).toBe(HEADER)
  })

  it('serializes a database file of the app to the bytes the file holds', () => {
    const db = filled(FILE, 60)
    const bytes = db.serialize()
    expect(ShimBuffer.from(fs.contents('data/main.sqlite3') as Uint8Array).equals(bytes)).toBe(true)
    db.close()
  })

  it('is read by Node\'s own node:sqlite, and reads what Node wrote', () => {
    const bytes = filled(':memory:', 20).serialize()
    const directory = mkdtempSync(join(tmpdir(), 'orivon-image-'))
    try {
      writeFileSync(join(directory, 'x.db'), bytes)
      const node = new NodeDatabaseSync(join(directory, 'x.db'))
      expect(node.prepare('select count(*) as c from t').get()).toEqual({ c: 20 })
      expect(node.prepare('pragma integrity_check').get()).toEqual({ integrity_check: 'ok' })
      node.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('serializes a database with nothing in it to a page the engine can open', () => {
    const db = new Database(':memory:')
    const empty = db.serialize()
    expect(empty.length % 512).toBe(0)
    expect(new Database(empty).prepare('select count(*) from sqlite_master').pluck().get()).toBe(0)
    db.exec('create table t (a)')
    expect(db.serialize().length).toBeGreaterThanOrEqual(empty.length)
  })

  it('serializes an attached database by name', () => {
    const db = filled(':memory:', 3)
    db.exec("attach ':memory:' as other; create table other.o (a); insert into other.o values (1), (2)")
    const other = new Database(db.serialize({ attached: 'other' }))
    expect(other.prepare('select count(*) from o').pluck().get()).toBe(2)
    expect(() => other.prepare('select * from t')).toThrow(/no such table/)
    expect(new Database(db.serialize({ attached: 'main' })).prepare('select count(*) from t').pluck().get()).toBe(3)
    expect(new Database(db.serialize({})).prepare('select count(*) from t').pluck().get()).toBe(3)
    expect(new Database(db.serialize(null as never)).prepare('select count(*) from t').pluck().get()).toBe(3)
  })

  it('checks its arguments with better-sqlite3\'s messages, and refuses a database that is not there', () => {
    const db = filled(':memory:', 1)
    const call = (...args: unknown[]) => () => (db as unknown as { serialize (...a: unknown[]): unknown }).serialize(...args)
    expect(call(5)).toThrow(new TypeError('Expected first argument to be an options object'))
    expect(call({ attached: 5 })).toThrow(new TypeError('Expected the "attached" option to be a string'))
    expect(call({ attached: '' })).toThrow(new TypeError('The "attached" option cannot be an empty string'))
    expect(call({ attached: 'nowhere' })).toThrow(expect.objectContaining({ name: 'SqliteError', code: 'SQLITE_ERROR', message: 'unknown database nowhere' }))
  })

  it('cannot run while a function is running on the connection', () => {
    const db = filled(':memory:', 1)
    db.function('snapshot', () => { db.serialize(); return 1 })
    expect(() => db.prepare('select snapshot()').get()).toThrow(new TypeError('This database connection is busy executing a query'))
  })

  it('serializes the committed state of a database and a transaction in progress does not break it', () => {
    const db = filled(':memory:', 3)
    db.exec('begin')
    db.prepare('insert into t (body) values (?)').run('pending')
    const bytes = db.serialize()
    db.exec('rollback')
    expect(count(new Database(bytes))).toBeGreaterThanOrEqual(3)
    expect(count(db)).toBe(3)
  })
})
