// `better-sqlite3`'s Database#function over the shim: its argument checks and
// messages, how values cross in both directions, and what an exception does.

import { beforeAll, describe, expect, it } from 'vitest'
import Database, { SqliteError } from '../better-sqlite3.js'
import { collectGarbage } from '../../tests/support/collect-garbage.js'
import { loadTestEngine } from './support/engine.js'

beforeAll(loadTestEngine)

function value (db: InstanceType<typeof Database>, sql: string): unknown {
  return db.prepare(sql).pluck().get()
}

describe('registering', () => {
  it('returns the database, and takes (name, fn), (name, options, fn) and (name, null, fn)', () => {
    const db = new Database(':memory:')
    expect(db.function('a', () => 1)).toBe(db)
    expect(db.function('b', {}, () => 2)).toBe(db)
    expect(db.function('c', null as never, () => 3)).toBe(db)
    expect([value(db, 'select a()'), value(db, 'select b()'), value(db, 'select c()')]).toEqual([1, 2, 3])
  })

  it('checks its arguments with better-sqlite3\'s messages', () => {
    const db = new Database(':memory:')
    const call = (...args: unknown[]) => () => (db as unknown as { function (...a: unknown[]): unknown }).function(...args)
    expect(call(5, () => 1)).toThrow(new TypeError('Expected first argument to be a string'))
    expect(call('f')).toThrow(new TypeError('Expected last argument to be a function'))
    expect(call('f', {}, 5)).toThrow(new TypeError('Expected last argument to be a function'))
    expect(call('f', 5, () => 1)).toThrow(new TypeError('Expected second argument to be an options object'))
    expect(call('', () => 1)).toThrow(new TypeError('User-defined function name cannot be an empty string'))
    for (const option of ['safeIntegers', 'deterministic', 'directOnly', 'varargs']) {
      expect(call('f', { [option]: 1 }, () => 1), option).toThrow(new TypeError(`Expected the "${option}" option to be a boolean`))
    }
  })

  it('refuses more than 100 declared arguments, unless varargs', () => {
    const db = new Database(':memory:')
    const many = new Function(...Array.from({ length: 101 }, (_, i) => `a${String(i)}`), 'return 1') as () => number
    expect(() => db.function('f', many)).toThrow(new RangeError('User-defined functions cannot have more than 100 arguments'))
    db.function('f', { varargs: true }, many)
    const hundred = new Function(...Array.from({ length: 100 }, (_, i) => `a${String(i)}`), 'return 7') as () => number
    db.function('g', hundred)
    expect(value(db, `select g(${Array.from({ length: 100 }, () => '1').join(',')})`)).toBe(7)
  })

  it('refuses a closed database', () => {
    const db = new Database(':memory:')
    db.close()
    expect(() => db.function('f', () => 1)).toThrow(new TypeError('The database connection is not open'))
  })

  it('a function of the same name replaces the earlier one, and a statement prepared before sees it', () => {
    const db = new Database(':memory:')
    db.function('f', () => 1)
    const statement = db.prepare('select f() as v').pluck()
    expect(statement.get()).toBe(1)
    db.function('f', () => 2)
    expect(statement.get()).toBe(2)
  })

  it('cannot replace a function while a statement is running', () => {
    const db = new Database(':memory:')
    db.function('f', () => 1)
    const running = db.prepare('select f() union all select f()').pluck().iterate()
    running.next()
    expect(() => db.function('f', () => 2)).toThrow(expect.objectContaining({ name: 'SqliteError', message: 'unable to delete/modify user-function due to active statements' }))
  })
})

describe('the arguments of a call', () => {
  const capture = (db: InstanceType<typeof Database>, options: object = {}): unknown[][] => {
    const seen: unknown[][] = []
    db.function('g', { varargs: true, ...options }, (...args: unknown[]) => { seen.push(args); return 1 })
    return seen
  }

  it('INTEGER and REAL are numbers, TEXT a string, BLOB bytes, NULL null', () => {
    const db = new Database(':memory:')
    const seen = capture(db)
    db.prepare("select g(1, 1.5, 'h\u00e9llo', x'0102', null, '', x'')").get()
    expect(seen).toEqual([[1, 1.5, 'h\u00e9llo', new Uint8Array([1, 2]), null, '', new Uint8Array(0)]])
  })

  it('an INTEGER past 2^53 is a number that has lost precision, as better-sqlite3 hands it', () => {
    const db = new Database(':memory:')
    const seen = capture(db)
    db.prepare('select g(9007199254740993, -9223372036854775807)').get()
    expect(seen[0]).toEqual([9007199254740992, -9223372036854775808])
  })

  it('safeIntegers hands every INTEGER over as a bigint, and not a REAL', () => {
    const db = new Database(':memory:')
    const seen = capture(db, { safeIntegers: true })
    db.prepare('select g(1, 9007199254740993, 1.5)').get()
    expect(seen[0]).toEqual([1n, 9007199254740993n, 1.5])
  })

  it('with no option, defaultSafeIntegers decides, at the time of the call', () => {
    const db = new Database(':memory:')
    const seen = capture(db)
    db.prepare('select g(1)').get()
    db.defaultSafeIntegers(true)
    db.prepare('select g(1)').get()
    expect(seen).toEqual([[1], [1n]])
  })

  it('safeIntegers: false beats defaultSafeIntegers', () => {
    const db = new Database(':memory:').defaultSafeIntegers(true)
    const seen = capture(db, { safeIntegers: false })
    db.prepare('select g(1)').get()
    expect(seen).toEqual([[1]])
  })

  it('a wrong number of arguments is an SQLite error naming the function', () => {
    const db = new Database(':memory:')
    db.function('two', (_a: unknown, _b: unknown) => 1)
    expect(() => db.prepare('select two(1)').get()).toThrow(new SqliteError('wrong number of arguments to function two()', 'SQLITE_ERROR'))
    expect(() => db.prepare('select two(1, 2, 3)').get()).toThrow(expect.objectContaining({ name: 'SqliteError' }))
  })

  it('varargs takes any number', () => {
    const db = new Database(':memory:')
    db.function('count_args', { varargs: true }, (...args: unknown[]) => args.length)
    expect([value(db, 'select count_args()'), value(db, 'select count_args(1)'), value(db, 'select count_args(1,2,3)')]).toEqual([0, 1, 3])
  })

  it('the function is called with no this', () => {
    const db = new Database(':memory:')
    let seen: unknown = 'unset'
    db.function('f', function (this: unknown) { seen = this; return 1 })
    db.prepare('select f()').get()
    expect(seen).toBeUndefined()
  })
})

describe('the result of a call', () => {
  const resultOf = (returned: unknown): { type: unknown, value: unknown } => {
    const db = new Database(':memory:')
    db.function('f', () => returned)
    return db.prepare('select typeof(f()) as type, f() as value').get() as { type: unknown, value: unknown }
  }

  it('a number is REAL, even when it has no fraction', () => {
    expect(resultOf(5)).toEqual({ type: 'real', value: 5 })
    expect(resultOf(5.5)).toEqual({ type: 'real', value: 5.5 })
  })

  it('a bigint is INTEGER', () => {
    expect(resultOf(5n)).toEqual({ type: 'integer', value: 5 })
    expect(resultOf(2n ** 63n - 1n).type).toBe('integer')
  })

  it('a string is TEXT, and a buffer is BLOB', () => {
    expect(resultOf('h\u00e9llo \u{1F600}')).toEqual({ type: 'text', value: 'h\u00e9llo \u{1F600}' })
    expect(resultOf('')).toEqual({ type: 'text', value: '' })
    expect(resultOf(new Uint8Array([1, 2, 3]))).toEqual({ type: 'blob', value: new Uint8Array([1, 2, 3]) })
    expect(resultOf(new Uint8Array(0))).toEqual({ type: 'blob', value: new Uint8Array(0) })
    expect(resultOf(new Uint8Array([9, 1, 2, 9]).subarray(1, 3)).value).toEqual(new Uint8Array([1, 2]))
  })

  it('null and undefined are NULL', () => {
    expect(resultOf(null)).toEqual({ type: 'null', value: null })
    expect(resultOf(undefined)).toEqual({ type: 'null', value: null })
  })

  it('anything else is a TypeError, and the statement does not complete', () => {
    for (const bad of [true, {}, [], Symbol('s'), 2n ** 63n]) {
      const db = new Database(':memory:')
      db.function('f', () => bad)
      db.exec('create table t (a)')
      expect(() => db.prepare('insert into t select f()').run(), String(typeof bad)).toThrow(new TypeError('User-defined functions can only return numbers, strings, bigints, buffers, and null'))
      expect(value(db, 'select count(*) from t')).toBe(0)
    }
  })
})

describe('an exception in the function', () => {
  it('is thrown, as it is, by the statement call that ran the function', () => {
    const db = new Database(':memory:')
    const boom = new RangeError('bang')
    db.function('boom', () => { throw boom })
    for (const run of [() => db.prepare('select boom()').get(), () => db.prepare('select boom()').all(), () => db.prepare('select boom()').run(), () => db.exec('select boom()'), () => [...db.prepare('select boom()').iterate()]]) {
      expect(run).toThrow(boom)
      try { run() } catch (error) { expect(error).toBe(boom) }
    }
  })

  it('fails the statement: an insert leaves no row, and the database stays usable', () => {
    const db = new Database(':memory:')
    db.exec('create table t (a)')
    db.function('maybe', (x: unknown) => { if (x === 2) throw new Error('two'); return x })
    expect(() => db.prepare('insert into t select maybe(column1) from (values (1), (2), (3))').run()).toThrow(new Error('two'))
    expect(value(db, 'select count(*) from t')).toBe(0)
    expect(db.inTransaction).toBe(false)
    db.prepare('insert into t values (?)').run(1)
    expect(value(db, 'select count(*) from t')).toBe(1)
  })

  it('rolls back a transaction function that runs it', () => {
    const db = new Database(':memory:')
    db.exec('create table t (a)')
    db.function('boom', () => { throw new Error('inside') })
    const work = db.transaction(() => {
      db.prepare('insert into t values (1)').run()
      db.prepare('select boom()').get()
    })
    expect(work).toThrow(new Error('inside'))
    expect(db.inTransaction).toBe(false)
    expect(value(db, 'select count(*) from t')).toBe(0)
  })

  it('cannot close the database or run the statement it is in the middle of', () => {
    const db = new Database(':memory:')
    const seen: unknown[] = []
    let statement: ReturnType<typeof db.prepare> | undefined
    db.function('inside', () => {
      for (const attempt of [() => db.close(), () => statement?.get()]) { try { attempt() } catch (error) { seen.push(error) } }
      return 1
    })
    statement = db.prepare('select inside() as v')
    expect(statement.get()).toEqual({ v: 1 })
    expect(seen).toEqual([new TypeError('This database connection is busy executing a query'), new TypeError('This database connection is busy executing a query')])
    expect(db.open).toBe(true)
  })

  it('does not hold a database nobody references', async () => {
    const ref = ((): WeakRef<object> => {
      const db = new Database(':memory:')
      db.function('f', () => 1)
      db.defaultSafeIntegers(true)
      db.prepare('select f()').get()
      return new WeakRef(db)
    })()
    await collectGarbage()
    expect(ref.deref()).toBeUndefined()
  })

  it('does not turn a later engine error into the earlier exception', () => {
    const db = new Database(':memory:')
    db.function('boom', () => { throw new Error('first') })
    expect(() => db.prepare('select boom()').get()).toThrow(new Error('first'))
    expect(() => db.prepare('select * from missing').get()).toThrow(expect.objectContaining({ name: 'SqliteError', message: 'no such table: missing' }))
  })
})

describe('the flags', () => {
  it('deterministic lets an expression index use the function, and without it SQLite refuses', () => {
    const db = new Database(':memory:')
    db.exec('create table t (a)')
    db.function('square', { deterministic: true }, (x: unknown) => (x as number) * (x as number))
    db.exec('create index t_square on t (square(a))')
    db.exec('insert into t values (2), (3)')
    expect(db.prepare('select a from t where square(a) = 9').pluck().all()).toEqual([3])
    expect(db.prepare('explain query plan select a from t where square(a) = 9').all().map((row) => (row as { detail: string }).detail).join()).toContain('t_square')
    db.function('plain', (x: unknown) => x)
    expect(() => db.exec('create index t_plain on t (plain(a))')).toThrow(expect.objectContaining({ name: 'SqliteError' }))
  })

  it('directOnly refuses a call from a view or a trigger', () => {
    const db = new Database(':memory:')
    db.function('direct', { directOnly: true }, () => 1)
    db.function('open', () => 1)
    expect(value(db, 'select direct()')).toBe(1)
    db.exec('create view v_direct as select direct() as x; create view v_open as select open() as x')
    expect(value(db, 'select x from v_open')).toBe(1)
    expect(() => value(db, 'select x from v_direct')).toThrow(expect.objectContaining({ name: 'SqliteError', message: 'unsafe use of direct()' }))
  })
})

describe('functions that stand in for what SQLite lacks', () => {
  it('REGEXP, and Unicode case mapping, normalisation and LIKE, in WHERE, ORDER BY and an expression index', () => {
    const db = new Database(':memory:')
    db.function('regexp', { deterministic: true }, (pattern: unknown, text: unknown) => typeof pattern === 'string' && typeof text === 'string' && new RegExp(pattern, 'u').test(text) ? 1 : 0)
    db.function('unicode_lower', { deterministic: true }, (text: unknown) => typeof text === 'string' ? text.toLowerCase() : text)
    db.function('unicode_upper', { deterministic: true }, (text: unknown) => typeof text === 'string' ? text.toUpperCase() : text)
    db.function('normalise', { deterministic: true }, (text: unknown) => typeof text === 'string' ? text.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : text)
    db.function('unicode_like', { deterministic: true }, (pattern: unknown, text: unknown) => {
      if (typeof pattern !== 'string' || typeof text !== 'string') return 0
      return new RegExp(`^${pattern.replace(/[.*+?^${'$'}{}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`, 'iu').test(text) ? 1 : 0
    })
    db.exec('create table names (name text)')
    db.exec('create index names_lower on names (unicode_lower(name))')
    const insert = db.prepare('insert into names values (?)')
    for (const name of ['\u00c9lodie', '\u00e9mile', 'Zo\u00eb', 'Ana', 'ANDR\u00c9', 'beta-9']) insert.run(name)
    const names = (sql: string, ...args: unknown[]): unknown[] => db.prepare(sql).pluck().all(...args)
    expect(names("select name from names where name regexp '^\\p{Lu}'")).toEqual(['\u00c9lodie', 'Zo\u00eb', 'Ana', 'ANDR\u00c9'])
    expect(names('select name from names where unicode_lower(name) = ?', '\u00e9lodie')).toEqual(['\u00c9lodie'])
    expect(names('select unicode_upper(name) from names where name like ?', 'zo%')).toEqual(['ZO\u00cb'])
    expect(names("select name from names where unicode_like('%\u00c9', name)")).toEqual(['ANDR\u00c9'])
    expect(names('select normalise(name) from names order by unicode_lower(normalise(name))')).toEqual(['Ana', 'ANDRE', 'beta-9', 'Elodie', 'emile', 'Zoe'])
    expect(names('select name from names where name not regexp ?', '[a-z]')).toEqual(['ANDR\u00c9'])
  })
})
