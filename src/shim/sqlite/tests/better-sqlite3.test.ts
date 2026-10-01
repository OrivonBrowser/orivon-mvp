// `better-sqlite3`'s Database over the shim: the constructor and its options,
// `exec`, `pragma`, `transaction`, closing, and the members refused by name.

import { beforeAll, describe, expect, it, vi } from 'vitest'
import Database, { SqliteError } from '../better-sqlite3.js'
import { loadTestEngine } from './support/engine.js'

beforeAll(loadTestEngine)

describe('the constructor', () => {
  it('works with new and as a plain call, and instanceof holds for both', () => {
    const made = new Database(':memory:')
    const called = Database(':memory:')
    expect(made).toBeInstanceOf(Database)
    expect(called).toBeInstanceOf(Database)
    expect(Database.SqliteError).toBe(SqliteError)
  })

  it('can be extended', () => {
    class Store extends Database {
      count (): unknown { return this.prepare('SELECT 1 AS n').pluck().get() }
    }
    const store = new Store(':memory:')
    expect(store).toBeInstanceOf(Store)
    expect(store).toBeInstanceOf(Database)
    expect(store.count()).toBe(1)
  })

  it('opens :memory: and an empty name, with no argument too', () => {
    for (const db of [new Database(':memory:'), new Database(''), new Database()]) {
      expect(db.memory).toBe(true)
      expect(db.open).toBe(true)
      expect(db.readonly).toBe(false)
      expect(db.prepare('SELECT 1 AS one').get()).toEqual({ one: 1 })
    }
    expect(new Database(':memory:').name).toBe(':memory:')
    expect(new Database().name).toBe('')
  })

  it('validates its arguments as better-sqlite3 does', () => {
    expect(() => new Database(5 as never)).toThrow(new TypeError('Expected first argument to be a string'))
    expect(() => new Database(':memory:', 5 as never)).toThrow(new TypeError('Expected second argument to be an options object'))
    expect(() => new Database(':memory:', { readOnly: true } as never)).toThrow(new TypeError('Misspelled option "readOnly" should be "readonly"'))
    expect(() => new Database(':memory:', { memory: true } as never)).toThrow(new TypeError('Option "memory" was removed in v7.0.0 (use ":memory:" filename instead)'))
    expect(() => new Database(':memory:', { readonly: true })).toThrow(new TypeError('In-memory/temporary databases cannot be readonly'))
    expect(() => new Database(':memory:', { readonly: 'yes' as never })).toThrow(new TypeError('Expected the "readonly" option to be a boolean'))
    expect(() => new Database(':memory:', { timeout: -1 })).toThrow(new TypeError('Expected the "timeout" option to be a positive integer'))
    expect(() => new Database(':memory:', { timeout: 2 ** 31 })).toThrow(new RangeError('Option "timeout" cannot be greater than 2147483647'))
    expect(() => new Database(':memory:', { verbose: 'log' as never })).toThrow(new TypeError('Expected the "verbose" option to be a function'))
    expect(() => new Database(':memory:', { nativeBinding: 5 })).toThrow(new TypeError('Expected the "nativeBinding" option to be a string or addon object'))
  })

  it('accepts timeout and nativeBinding, and refuses a Buffer by name', () => {
    expect(new Database(':memory:', { timeout: 100, nativeBinding: '/elsewhere/better_sqlite3.node' }).open).toBe(true)
    expect(() => new Database(Buffer.from('x') as never)).toThrow(expect.objectContaining({ name: 'OrivonShimError', reason: 'not-built' }))
  })

  it('calls verbose with each statement\'s SQL, parameters filled in', () => {
    const verbose = vi.fn()
    const db = new Database(':memory:', { verbose })
    db.exec('CREATE TABLE t (a, b)')
    db.prepare('INSERT INTO t VALUES (?, ?)').run(5, 'x')
    db.prepare('SELECT * FROM t').all()
    expect(verbose.mock.calls.map(([sql]) => sql)).toEqual(['CREATE TABLE t (a, b)', "INSERT INTO t VALUES (5, 'x')", 'SELECT * FROM t'])
  })

  it('a database file asks for a Worker of an isolated app, as DatabaseSync does', () => {
    expect(() => new Database('data.sqlite')).toThrow(expect.objectContaining({ name: 'OrivonShimError', reason: 'not-built' }))
    expect(() => new Database('data.sqlite', { fileMustExist: true })).toThrow(expect.objectContaining({ name: 'OrivonShimError', reason: 'not-built' }))
  })
})

describe('exec, close and state', () => {
  it('exec returns the database and runs several statements', () => {
    const db = new Database(':memory:')
    expect(db.exec('CREATE TABLE t (a); INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)')).toBe(db)
    expect(db.prepare('SELECT count(*) FROM t').pluck().get()).toBe(2)
    expect(() => db.exec('NOT SQL')).toThrow(expect.objectContaining({ name: 'SqliteError', code: 'SQLITE_ERROR' }))
    expect(() => db.exec(1 as never)).toThrow(new TypeError('Expected first argument to be a string'))
  })

  it('close returns the database, is safe twice, and later calls are TypeErrors', () => {
    const db = new Database(':memory:')
    expect(db.close()).toBe(db)
    expect(db.open).toBe(false)
    expect(db.inTransaction).toBe(false)
    expect(db.close()).toBe(db)
    for (const call of [() => db.prepare('SELECT 1'), () => db.exec('SELECT 1'), () => db.pragma('user_version')]) {
      expect(call).toThrow(new TypeError('The database connection is not open'))
    }
  })

  it('inTransaction follows BEGIN and COMMIT', () => {
    const db = new Database(':memory:')
    expect(db.inTransaction).toBe(false)
    db.exec('BEGIN')
    expect(db.inTransaction).toBe(true)
    db.exec('COMMIT')
    expect(db.inTransaction).toBe(false)
  })

  it('defaultSafeIntegers applies to statements prepared afterwards', () => {
    const db = new Database(':memory:')
    const before = db.prepare('SELECT 1 AS n')
    expect(db.defaultSafeIntegers()).toBe(db)
    const after = db.prepare('SELECT 1 AS n')
    expect(before.get()).toEqual({ n: 1 })
    expect(after.get()).toEqual({ n: 1n })
    db.defaultSafeIntegers(false)
    expect(db.prepare('SELECT 1 AS n').get()).toEqual({ n: 1 })
    expect(() => db.defaultSafeIntegers('on' as never)).toThrow(new TypeError('Expected first argument to be a boolean'))
  })

  it('unsafeMode is a no-op that returns the database', () => {
    const db = new Database(':memory:')
    expect(db.unsafeMode()).toBe(db)
    expect(db.unsafeMode(false)).toBe(db)
  })
})

describe('pragma', () => {
  it('returns rows, or the first column of the first row with simple', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
    expect(db.pragma('table_info(t)')).toEqual([
      { cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
      { cid: 1, name: 'name', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 }
    ])
    expect(db.pragma('user_version')).toEqual([{ user_version: 0 }])
    expect(db.pragma('user_version', { simple: true })).toBe(0)
  })

  it('a pragma that sets a value works, and the engine\'s answer comes back', () => {
    const db = new Database(':memory:')
    expect(db.pragma('user_version = 3')).toEqual([])
    expect(db.pragma('user_version', { simple: true })).toBe(3)
    expect(db.pragma('user_version = 4', { simple: true })).toBeUndefined()
    expect(db.pragma('foreign_keys = OFF')).toEqual([])
    expect(db.pragma('foreign_keys', { simple: true })).toBe(0)
    db.pragma('foreign_keys = ON')
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(db.pragma('journal_mode = WAL')).toEqual([{ journal_mode: 'memory' }])
    expect(db.pragma('journal_mode = WAL', { simple: true })).toBe('memory')
  })

  it('foreign keys are on by default', () => {
    expect(new Database(':memory:').pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('checks its arguments', () => {
    const db = new Database(':memory:')
    expect(() => db.pragma(1 as never)).toThrow(new TypeError('Expected first argument to be a string'))
    expect(() => db.pragma('user_version', 1 as never)).toThrow(new TypeError('Expected second argument to be an options object'))
    expect(() => db.pragma('no_such_pragma_at_all = 1')).not.toThrow()
  })
})

describe('transaction', () => {
  function counter (): InstanceType<typeof Database> {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE t (n INTEGER)')
    return db
  }
  const count = (db: InstanceType<typeof Database>): unknown => db.prepare('SELECT count(*) FROM t').pluck().get()

  it('commits what the function did and returns its result, with arguments and this passed through', () => {
    const db = counter()
    const insert = db.prepare('INSERT INTO t VALUES (?)')
    const context = { tag: 'ctx' }
    const add = db.transaction(function (this: unknown, ...values: number[]) {
      for (const value of values) insert.run(value)
      return [this, values.length]
    })
    expect(add.call(context, 1, 2, 3)).toEqual([context, 3])
    expect(count(db)).toBe(3)
    expect(db.inTransaction).toBe(false)
  })

  it('rolls back and rethrows when the function throws', () => {
    const db = counter()
    const failing = db.transaction(() => {
      db.prepare('INSERT INTO t VALUES (1)').run()
      throw new Error('boom')
    })
    expect(() => failing()).toThrow(new Error('boom'))
    expect(count(db)).toBe(0)
    expect(db.inTransaction).toBe(false)
  })

  it('a constraint failure inside rolls everything back', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE t (n INTEGER UNIQUE)')
    const insertAll = db.transaction((values: number[]) => { for (const value of values) db.prepare('INSERT INTO t VALUES (?)').run(value) })
    expect(() => insertAll([1, 2, 2])).toThrow(expect.objectContaining({ code: 'SQLITE_CONSTRAINT_UNIQUE' }))
    expect(count(db)).toBe(0)
  })

  it('nests as a savepoint: an inner failure undoes only the inner work', () => {
    const db = counter()
    const insert = db.prepare('INSERT INTO t VALUES (?)')
    const inner = db.transaction((value: number, fail: boolean) => {
      insert.run(value)
      expect(db.inTransaction).toBe(true)
      if (fail) throw new Error('inner')
    })
    const outer = db.transaction(() => {
      insert.run(1)
      inner(2, false)
      try { inner(3, true) } catch { /* the outer transaction carries on */ }
      insert.run(4)
    })
    outer()
    expect(db.prepare('SELECT n FROM t ORDER BY n').pluck().all()).toEqual([1, 2, 4])
    expect(db.inTransaction).toBe(false)
  })

  it('an error the outer transaction does not catch rolls back the inner work too', () => {
    const db = counter()
    const inner = db.transaction(() => { db.prepare('INSERT INTO t VALUES (2)').run() })
    const outer = db.transaction(() => { db.prepare('INSERT INTO t VALUES (1)').run(); inner(); throw new Error('late') })
    expect(() => outer()).toThrow(new Error('late'))
    expect(count(db)).toBe(0)
  })

  it('has deferred, immediate and exclusive variants that begin as named', () => {
    const verbose = vi.fn()
    const db = new Database(':memory:', { verbose })
    const work = db.transaction((value: string) => value)
    expect([work.default('a'), work.deferred('b'), work.immediate('c'), work.exclusive('d')]).toEqual(['a', 'b', 'c', 'd'])
    expect(verbose.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN', 'COMMIT', 'BEGIN DEFERRED', 'COMMIT', 'BEGIN IMMEDIATE', 'COMMIT', 'BEGIN EXCLUSIVE', 'COMMIT'
    ])
    expect(work.database).toBe(db)
    expect(work.immediate.database).toBe(db)
    expect(work.immediate.deferred).toBeTypeOf('function')
  })

  it('a variant nests as a savepoint too', () => {
    const verbose = vi.fn()
    const db = new Database(':memory:', { verbose })
    const inner = db.transaction(() => 1)
    db.transaction(() => inner.immediate())()
    const statements = verbose.mock.calls.map(([sql]) => sql as string)
    expect(statements[0]).toBe('BEGIN')
    expect(statements[1]).toMatch(/^SAVEPOINT `_bs3\.\w+`$/)
    expect(statements[2]).toMatch(/^RELEASE `_bs3\.\w+`$/)
    expect(statements[3]).toBe('COMMIT')
  })

  it('refuses a function that returns a promise, and rolls back', () => {
    const db = counter()
    const async = db.transaction(() => { db.prepare('INSERT INTO t VALUES (1)').run(); return Promise.resolve(1) })
    expect(() => async()).toThrow(new TypeError('Transaction function cannot return a promise'))
    expect(count(db)).toBe(0)
  })

  it('checks that it is given a function', () => {
    expect(() => new Database(':memory:').transaction(1 as never)).toThrow(new TypeError('Expected first argument to be a function'))
  })

  it('a transaction function that ended the transaction itself does not roll back again', () => {
    const db = counter()
    const ends = db.transaction(() => { db.exec('COMMIT'); throw new Error('after commit') })
    expect(() => ends()).toThrow(new Error('after commit'))
    expect(db.inTransaction).toBe(false)
  })
})

describe('members refused by name', () => {
  it.each(['function', 'aggregate', 'table', 'backup', 'serialize', 'loadExtension'] as const)('db.%s', (member) => {
    const db = new Database(':memory:') as unknown as Record<string, () => unknown>
    let caught: unknown
    try { (db[member] as () => unknown)() } catch (error) { caught = error }
    expect(caught).toMatchObject({ name: 'OrivonShimError', api: `better-sqlite3.Database.${member}`, reason: 'not-built' })
  })
})
