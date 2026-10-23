// DatabaseSync#function, each case run against Node's own node:sqlite and this
// module on the same input: results, values and errors must be the same.

import { beforeAll, describe, expect, it } from 'vitest'
import { collectGarbage } from '../../tests/support/collect-garbage.js'
import { sqliteEngine } from '../engine.js'
import { DatabaseSync } from '../database.js'
import { same } from './support/compare.js'
import { loadTestEngine } from './support/engine.js'

beforeAll(loadTestEngine)

type Registering = { function (...args: unknown[]): void, prepare (sql: string): { get (...args: never[]): unknown, all (...args: never[]): unknown[] }, exec (sql: string): void, close (): void }
const asDb = (db: unknown): Registering => db as Registering

describe('what a function returns', () => {
  const returning = (value: unknown, sql = 'select f(1) as v, typeof(f(1)) as t') => (db: unknown) => {
    asDb(db).function('f', (_x: unknown) => value)
    return asDb(db).prepare(sql).get()
  }
  same('an integer-valued number is stored as REAL', returning(5))
  same('a fraction', returning(5.5))
  same('NaN is NULL, as SQLite stores it', returning(Number.NaN))
  same('a bigint is stored as INTEGER', returning(5n))
  same('the largest and smallest 64-bit integers', (db) => {
    asDb(db).function('f', (x: unknown) => x === 1 ? 2n ** 63n - 1n : -(2n ** 63n))
    return asDb(db).prepare('select f(1) as a, f(2) as b').get()
  })
  same('a bigint past 64 bits fails the statement', returning(2n ** 63n))
  same('a string, with a multi-byte character', returning('héllo \u{1F600}'))
  same('an empty string', returning('', 'select f(1) as v, typeof(f(1)) as t, length(f(1)) as n'))
  same('a Uint8Array is a BLOB', returning(new Uint8Array([1, 2, 3]), 'select typeof(f(1)) as t, length(f(1)) as n, hex(f(1)) as h'))
  same('a view over part of a buffer is the part', returning(new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4), 'select hex(f(1)) as h'))
  same('undefined is NULL', returning(undefined))
  same('null is NULL', returning(null))
  same('a boolean fails the statement', returning(true))
  same('an object fails the statement', returning({}))
  same('a symbol fails the statement', returning(Symbol('s')))
})

it('an empty buffer is an empty BLOB, where Node stores NULL or an empty BLOB by the buffer\'s address', () => {
  const db = new DatabaseSync(':memory:')
  db.function('f', (_x: unknown) => new Uint8Array(0))
  expect(db.prepare('select typeof(f(1)) as t, length(f(1)) as n').get()).toEqual(expect.objectContaining({ t: 'blob', n: 0 }))
})

describe('what a function receives', () => {
  const receiving = (options: object, sql: string) => (db: unknown) => {
    const seen: unknown[][] = []
    asDb(db).function('g', { varargs: true, ...options }, (...args: unknown[]) => { seen.push(args); return 1 })
    const row = asDb(db).prepare(sql).get()
    return { row, seen }
  }
  same('each SQLite type', receiving({}, "select g(1, 1.5, 'a', x'0102', null, '') as v"))
  same('an integer as a bigint, when asked', receiving({ useBigIntArguments: true }, 'select g(1, 9007199254740993, -9223372036854775807) as v'))
  same('an integer past 2^53 fails the call, otherwise', receiving({}, 'select g(9007199254740993) as v'))
  same('an integer at 2^53 - 1 is a number', receiving({}, 'select g(9007199254740991, -9007199254740991) as v'))
  same('a REAL with no fraction stays a number', receiving({}, 'select g(2.0) as v'))
  same('an empty blob', receiving({}, "select g(x'') as v"))
  same('text with a multi-byte character', receiving({}, "select g('héllo \u{1F600}') as v"))
  same('a value from a column and a bound parameter', (db) => {
    asDb(db).exec('create table t (a, b)')
    asDb(db).exec("insert into t values (7, 'x')")
    return receiving({}, 'select g(a, b) as v from t')(db)
  })
  same('no arguments', receiving({}, 'select g() as v'))
  same('more arguments than the declared count fails', (db) => {
    asDb(db).function('h', (_a: unknown) => 1)
    return asDb(db).prepare('select h(1, 2) as v').get()
  })
  same('fewer arguments than the declared count fails', (db) => {
    asDb(db).function('h', (_a: unknown, _b: unknown) => 1)
    return asDb(db).prepare('select h(1) as v').get()
  })
  same('a function of one argument is called with one', (db) => {
    asDb(db).function('h', (...args: unknown[]) => args.length)
    return asDb(db).prepare('select h(1) as v').get()
  })
  same('a rest parameter alone declares no arguments, and varargs lifts it', (db) => {
    asDb(db).function('h', { varargs: true }, (...args: unknown[]) => args.length)
    return asDb(db).prepare('select h() as a, h(1) as b, h(1, 2, 3) as c').get()
  })
  same('the function is called with no this', (db) => {
    let seen: unknown = 'unset'
    asDb(db).function('h', { varargs: true }, function (this: unknown) { seen = this; return 1 })
    asDb(db).prepare('select h(1)').get()
    return { seen: seen === undefined }
  })
})

describe('an exception', () => {
  same('thrown by the function is thrown by the call that ran it', (db) => {
    asDb(db).function('boom', (_x: unknown) => { throw new RangeError('bang') })
    return asDb(db).prepare('select boom(1) as v').get()
  })
  same('thrown through exec', (db) => {
    asDb(db).function('boom', (_x: unknown) => { throw new RangeError('bang') })
    asDb(db).exec('select boom(1)')
  })
  same('that is not an Error is thrown as it was', (db) => {
    asDb(db).function('boom', (_x: unknown) => { throw 'text' })
    return asDb(db).prepare('select boom(1) as v').get()
  })
  it('that is a string, undefined or an object is the very value the call throws', () => {
    for (const thrown of ['text', undefined, { reason: 'object' }]) {
      const db = new DatabaseSync(':memory:')
      db.function('boom', (_x: unknown) => { throw thrown })
      let caught: unknown = 'nothing thrown'
      try { db.prepare('select boom(1)').get() } catch (error) { caught = error }
      expect(caught).toBe(thrown)
    }
  })
  same('fails the whole statement: no row of an insert stays', (db) => {
    asDb(db).exec('create table t (a)')
    asDb(db).function('maybe', (x: unknown) => { if (x === 2) throw new Error('two'); return x })
    let thrown: unknown
    try { asDb(db).exec('insert into t select maybe(column1) from (values (1), (2), (3))') } catch (error) { thrown = (error as Error).message }
    return { thrown, rows: asDb(db).prepare('select count(*) as n from t').get() }
  })
  same('does not poison the next statement', (db) => {
    asDb(db).function('boom', (_x: unknown) => { throw new Error('first') })
    try { asDb(db).exec('select boom(1)') } catch { /* expected */ }
    return asDb(db).prepare('select 1 as v').get()
  })
  same('a later engine error is its own, not the earlier exception', (db) => {
    asDb(db).function('boom', (_x: unknown) => { throw new Error('first') })
    try { asDb(db).exec('select boom(1)') } catch { /* expected */ }
    return asDb(db).prepare('select * from missing').get()
  })
  same('thrown by an iterated statement', (db) => {
    asDb(db).function('maybe', (x: unknown) => { if (x === 2) throw new Error('two'); return x })
    const rows: unknown[] = []
    const iterator = (db as { prepare (sql: string): { iterate (): Iterable<unknown> } }).prepare('select maybe(column1) as v from (values (1), (2), (3))').iterate()
    try { for (const row of iterator) rows.push(row) } catch (error) { rows.push((error as Error).message) }
    return rows
  })
})

describe('registering', () => {
  same('checks the name', (db) => { asDb(db).function(5, () => 1) })
  same('checks that a function is given', (db) => { asDb(db).function('f') })
  same('checks the function when options are given', (db) => { asDb(db).function('f', {}, 5) })
  same('checks the options', (db) => { asDb(db).function('f', 5, () => 1) })
  same('refuses null options', (db) => { asDb(db).function('f', null, () => 1) })
  same('checks each option is a boolean', (db) => {
    const results: unknown[] = []
    for (const option of ['useBigIntArguments', 'varargs', 'deterministic', 'directOnly']) {
      try { asDb(db).function('f', { [option]: 1 }, () => 1) } catch (error) { results.push((error as Error).message) }
    }
    return results
  })
  same('a name past 255 bytes', (db) => { asDb(db).function('x'.repeat(300), () => 1) })
  same('a function of the same name replaces the earlier one', (db) => {
    asDb(db).function('f', (_x: unknown) => 1)
    const first = asDb(db).prepare('select f(1) as v').get()
    asDb(db).function('f', (_x: unknown) => 2)
    return [first, asDb(db).prepare('select f(1) as v').get()]
  })
  same('the same name with another argument count is another function', (db) => {
    asDb(db).function('f', (_x: unknown) => 1)
    asDb(db).function('f', (_x: unknown, _y: unknown) => 2)
    return asDb(db).prepare('select f(1) as a, f(1, 1) as b').get()
  })
  same('cannot replace a function while a statement is running', (db) => {
    asDb(db).function('f', (_x: unknown) => 1)
    const running = (db as { prepare (sql: string): { iterate (): Iterator<unknown> } }).prepare('select f(1) union all select f(1)').iterate()
    running.next()
    asDb(db).function('f', (_x: unknown) => 2)
  })
  same('on a closed database', (db) => {
    asDb(db).close()
    asDb(db).function('f', () => 1)
  })
  same('a statement prepared before sees the replacement', (db) => {
    asDb(db).function('f', (_x: unknown) => 1)
    const statement = asDb(db).prepare('select f(1) as v')
    const before = statement.get()
    asDb(db).function('f', (_x: unknown) => 2)
    return [before, statement.get()]
  })
})

describe('the flags', () => {
  same('a deterministic function may index an expression', (db) => {
    asDb(db).function('square', { deterministic: true }, (x: unknown) => (x as number) * (x as number))
    asDb(db).exec('create table t (a); create index t_square on t (square(a)); insert into t values (2), (3)')
    return asDb(db).prepare('select a from t where square(a) = 9').all()
  })
  same('a function that is not deterministic may not', (db) => {
    asDb(db).function('square', (x: unknown) => (x as number) * (x as number))
    asDb(db).exec('create table t (a); create index t_square on t (square(a))')
  })
  same('a direct-only function may be called from a statement', (db) => {
    asDb(db).function('direct', { directOnly: true }, (_x: unknown) => 1)
    return asDb(db).prepare('select direct(1) as v').get()
  })
  same('a direct-only function may not be called from a view', (db) => {
    asDb(db).function('direct', { directOnly: true }, (_x: unknown) => 1)
    asDb(db).exec('create view v as select direct(1) as x')
    return asDb(db).prepare('select * from v').get()
  })
  same('a function that is not direct-only may be called from a view', (db) => {
    asDb(db).function('open', (_x: unknown) => 1)
    asDb(db).exec('create view v as select open(1) as x')
    return asDb(db).prepare('select * from v').get()
  })
})

describe('a function in use', () => {
  it('is called once for each row, in the order SQLite reads them', () => {
    const db = new DatabaseSync(':memory:')
    const seen: unknown[] = []
    db.function('tick', (x: unknown) => { seen.push(x); return seen.length })
    db.exec('create table t (a); insert into t values (10), (20), (30)')
    expect(db.prepare('select tick(a) as v from t order by a').all().map((row) => (row as { v: number }).v)).toEqual([1, 2, 3])
    expect(seen).toEqual([10, 20, 30])
    db.close()
  })

  it('gives its function table entries back when the connection closes or the function is replaced', () => {
    const table = (): number => (sqliteEngine().wasm as unknown as { functionTable (): { length: number } }).functionTable().length
    const cycle = (): void => {
      const db = new DatabaseSync(':memory:')
      for (let i = 0; i < 50; i++) db.function(`f${String(i)}`, (_x: unknown) => i)
      for (let i = 0; i < 50; i++) db.function('same', (_x: unknown) => i)
      db.close()
    }
    cycle()
    const after = table()
    for (let i = 0; i < 5; i++) cycle()
    expect(table()).toBe(after)
  })

  it('gives its entries back when registering fails', () => {
    const table = (): number => (sqliteEngine().wasm as unknown as { functionTable (): { length: number } }).functionTable().length
    const db = new DatabaseSync(':memory:')
    expect(() => db.function('x'.repeat(300), (_x: unknown) => 1)).toThrow()
    const after = table()
    for (let i = 0; i < 20; i++) expect(() => db.function('x'.repeat(300), (_x: unknown) => 1)).toThrow()
    expect(table()).toBe(after)
  })

  it('does not hold a database nobody references', async () => {
    const ref = ((): WeakRef<DatabaseSync> => {
      const db = new DatabaseSync(':memory:')
      db.function('f', (_x: unknown) => 1)
      db.prepare('select f(1)').get()
      return new WeakRef(db)
    })()
    await collectGarbage()
    expect(ref.deref()).toBeUndefined()
  })

  it('cannot be closed from inside a function, nor run its own statement again', () => {
    const db = new DatabaseSync(':memory:')
    let inner: unknown
    db.function('closer', (_x: unknown) => { try { db.close() } catch (error) { inner = error } return 1 })
    db.prepare('select closer(1)').get()
    expect(inner).toMatchObject({ code: 'ERR_INVALID_STATE', message: expect.stringContaining('busy') as string })
    expect(db.isOpen).toBe(true)
    db.function('again', (_x: unknown) => { try { statement.get() } catch (error) { inner = error } return 2 })
    const statement = db.prepare('select again(1) as v')
    expect(statement.get()).toEqual(expect.objectContaining({ v: 2 }))
    expect(inner).toMatchObject({ code: 'ERR_INVALID_STATE', message: expect.stringContaining('busy') as string })
    expect(statement.get()).toEqual(expect.objectContaining({ v: 2 }))
    db.close()
  })

  it('does not outlive a closed database: its callback is not called again', () => {
    const db = new DatabaseSync(':memory:')
    let calls = 0
    db.function('f', (_x: unknown) => ++calls)
    db.prepare('select f(1)').get()
    db.close()
    expect(calls).toBe(1)
    expect(() => db.prepare('select f(1)')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_STATE' }))
  })
})
