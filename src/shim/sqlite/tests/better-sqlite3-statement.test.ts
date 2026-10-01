// `better-sqlite3`'s Statement over the shim: results, the binding forms, the
// row shapes and the errors, as the package's own documentation states them.

import { beforeAll, describe, expect, it } from 'vitest'
import Database from '../better-sqlite3.js'
import { loadTestEngine } from './support/engine.js'

beforeAll(loadTestEngine)

function people (): InstanceType<typeof Database> {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT UNIQUE, age INTEGER, score REAL, photo BLOB)')
  return db
}

describe('run', () => {
  it('reports changes and the last row id as numbers', () => {
    const db = people()
    const insert = db.prepare('INSERT INTO people (name, age) VALUES (?, ?)')
    expect(insert.run('ada', 36)).toEqual({ changes: 1, lastInsertRowid: 1 })
    expect(insert.run('grace', 45)).toEqual({ changes: 1, lastInsertRowid: 2 })
    expect(db.prepare('UPDATE people SET age = age + 1').run()).toMatchObject({ changes: 2 })
    expect(db.prepare('DELETE FROM people WHERE id = ?').run(9)).toMatchObject({ changes: 0 })
  })

  it('runs a statement that returns rows', () => {
    const db = people()
    expect(() => db.prepare('SELECT 1').run()).not.toThrow()
  })

  it('reports the row id as a bigint with safeIntegers, and changes stays a number', () => {
    const db = people()
    const insert = db.prepare('INSERT INTO people (name) VALUES (?)').safeIntegers()
    expect(insert.run('ada')).toEqual({ changes: 1, lastInsertRowid: 1n })
  })
})

describe('get, all and iterate', () => {
  it('rows are plain objects of the column values', () => {
    const db = people()
    db.prepare('INSERT INTO people VALUES (?, ?, ?, ?, ?)').run(1, 'ada', 36, 1.5, Buffer.from([1, 2]))
    const row = db.prepare('SELECT * FROM people').get() as Record<string, unknown>
    expect(row).toEqual({ id: 1, name: 'ada', age: 36, score: 1.5, photo: new Uint8Array([1, 2]) })
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype)
    expect(db.prepare('SELECT * FROM people WHERE id = 7').get()).toBeUndefined()
    expect(db.prepare('SELECT * FROM people WHERE id = 7').all()).toEqual([])
  })

  it('all returns every row and iterate yields them one by one', () => {
    const db = people()
    for (const name of ['a', 'b', 'c']) db.prepare('INSERT INTO people (name) VALUES (?)').run(name)
    const select = db.prepare('SELECT name FROM people ORDER BY id')
    expect(select.all()).toEqual([{ name: 'a' }, { name: 'b' }, { name: 'c' }])
    const seen: unknown[] = []
    for (const row of select.iterate()) seen.push(row)
    expect(seen).toEqual([{ name: 'a' }, { name: 'b' }, { name: 'c' }])
    const iterator = select.iterate()
    expect(iterator.next()).toEqual({ value: { name: 'a' }, done: false })
    expect(iterator.return?.()).toMatchObject({ done: true })
    expect(select.all()).toHaveLength(3)
  })

  it('an integer too large for a double loses precision instead of throwing, and a bigint with safeIntegers', () => {
    const db = new Database(':memory:')
    const select = db.prepare('SELECT 9223372036854775807 AS big, 5 AS small')
    expect(select.get()).toEqual({ big: 9223372036854775807, small: 5 })
    expect(select.safeIntegers().get()).toEqual({ big: 9223372036854775807n, small: 5n })
    expect(select.safeIntegers(false).get()).toEqual({ big: 9223372036854775807, small: 5 })
  })

  it('a statement that returns no data refuses get, all and iterate', () => {
    const db = people()
    const insert = db.prepare('INSERT INTO people (name) VALUES (?)')
    for (const call of [() => insert.get('x'), () => insert.all('x'), () => insert.iterate('x')]) {
      expect(call).toThrow(new TypeError('This statement does not return data. Use run() instead'))
    }
  })

  it('duplicate column names keep the last, and a column named __proto__ is an own property', () => {
    const db = new Database(':memory:')
    expect(db.prepare('SELECT 1 AS a, 2 AS a').get()).toEqual({ a: 2 })
    const row = db.prepare('SELECT 3 AS __proto__').get() as object
    expect(Object.keys(row)).toEqual(['__proto__'])
  })
})

describe('binding', () => {
  it('positional arguments, an array, and both mixed', () => {
    const db = new Database(':memory:')
    const select = db.prepare('SELECT ? AS a, ? AS b, ? AS c')
    expect(select.get(1, 2, 3)).toEqual({ a: 1, b: 2, c: 3 })
    expect(select.get([1, 2, 3])).toEqual({ a: 1, b: 2, c: 3 })
    expect(select.get(1, [2, 3])).toEqual({ a: 1, b: 2, c: 3 })
  })

  it('numbered parameters take the argument at their number', () => {
    const db = new Database(':memory:')
    expect(db.prepare('SELECT ?2 AS x, ?1 AS y, ?2 AS z').get('one', 'two')).toEqual({ x: 'two', y: 'one', z: 'two' })
  })

  it('named parameters by bare key, for @, : and $', () => {
    const db = new Database(':memory:')
    expect(db.prepare('SELECT @a AS a, :b AS b, $c AS c').get({ a: 1, b: 'two', c: null })).toEqual({ a: 1, b: 'two', c: null })
    expect(db.prepare('SELECT @a AS x, @a AS y').get({ a: 7, unused: 1 })).toEqual({ x: 7, y: 7 })
  })

  it('a named object beside positional values', () => {
    const db = new Database(':memory:')
    expect(db.prepare('SELECT ? AS p, @n AS n, ? AS q').get('first', { n: 'named' }, 'second')).toEqual({ p: 'first', n: 'named', q: 'second' })
  })

  it('an integer that fits 32 bits is an INTEGER, any other number a REAL, as better-sqlite3 binds them', () => {
    const db = new Database(':memory:')
    const types = db.prepare('SELECT typeof(?) AS a, typeof(?) AS b, typeof(?) AS c, typeof(?) AS d, typeof(?) AS e, typeof(?) AS f, typeof(?) AS g')
    expect(types.get(1, 2 ** 31, 1.5, 2n ** 40n, 'x', Buffer.from('x'), null)).toEqual({ a: 'integer', b: 'real', c: 'real', d: 'integer', e: 'text', f: 'blob', g: 'null' })
    expect(types.get(-(2 ** 31), 0, undefined, 1, 1, 1, 1)).toMatchObject({ a: 'integer', b: 'integer', c: 'null' })
  })

  it('undefined binds NULL, and a value of another type is a TypeError', () => {
    const db = new Database(':memory:')
    const select = db.prepare('SELECT ? AS v')
    expect(select.get(undefined)).toEqual({ v: null })
    for (const bad of [true, {}, () => 1, new Date(), Symbol('x'), new ArrayBuffer(1)]) {
      expect(() => select.get([bad]), String(bad)).toThrow(new TypeError('SQLite3 can only bind numbers, strings, bigints, buffers, and null'))
    }
    expect(() => select.get(2n ** 70n)).toThrow(new RangeError('BigInt value is too large to bind'))
  })

  it('too few, too many and missing named parameters are RangeErrors', () => {
    const db = new Database(':memory:')
    expect(() => db.prepare('SELECT ?, ?').get(1)).toThrow(new RangeError('Too few parameter values were provided'))
    expect(() => db.prepare('SELECT ?').get(1, 2)).toThrow(new RangeError('Too many parameter values were provided'))
    expect(() => db.prepare('SELECT @a, @b').get({ a: 1 })).toThrow(new RangeError('Missing named parameter "b"'))
    expect(() => db.prepare('SELECT @a').get()).toThrow(new RangeError('Too few parameter values were provided'))
    expect(() => db.prepare('SELECT 1').get(1)).toThrow(new RangeError('Too many parameter values were provided'))
    expect(() => db.prepare('SELECT @a').get({ a: 1 }, { a: 2 })).toThrow(new TypeError('You cannot specify named parameters in two different objects'))
  })

  it('bind() fixes the parameters for every later call, once', () => {
    const db = new Database(':memory:')
    const select = db.prepare('SELECT ? AS a, @b AS b').bind(1, { b: 2 })
    expect(select.get()).toEqual({ a: 1, b: 2 })
    expect(select.all()).toEqual([{ a: 1, b: 2 }])
    expect(() => select.get(5)).toThrow(new TypeError('This statement already has bound parameters'))
    expect(() => select.bind(3)).toThrow(new TypeError('The bind() method can only be invoked once per statement object'))
  })
})

describe('pluck, raw, expand and columns', () => {
  function seeded (): InstanceType<typeof Database> {
    const db = people()
    db.prepare('INSERT INTO people (name, age) VALUES (?, ?)').run('ada', 36)
    db.prepare('INSERT INTO people (name, age) VALUES (?, ?)').run('grace', 45)
    return db
  }

  it('pluck returns the first column, and pluck(false) restores rows', () => {
    const select = seeded().prepare('SELECT name, age FROM people ORDER BY id')
    expect(select.pluck().all()).toEqual(['ada', 'grace'])
    expect(select.get()).toBe('ada')
    expect([...select.iterate()]).toEqual(['ada', 'grace'])
    expect(select.pluck(false).get()).toEqual({ name: 'ada', age: 36 })
  })

  it('raw returns arrays', () => {
    const select = seeded().prepare('SELECT name, age FROM people ORDER BY id')
    expect(select.raw().all()).toEqual([['ada', 36], ['grace', 45]])
    expect(select.raw(false).get()).toEqual({ name: 'ada', age: 36 })
  })

  it('expand nests columns by table, and an expression is under $', () => {
    const select = seeded().prepare('SELECT people.name, people.age, 1 + 1 AS two FROM people ORDER BY id')
    expect(select.expand().get()).toEqual({ people: { name: 'ada', age: 36 }, $: { two: 2 } })
  })

  it('pluck, raw and expand replace one another', () => {
    const select = seeded().prepare('SELECT name, age FROM people ORDER BY id')
    select.pluck().raw()
    expect(select.get()).toEqual(['ada', 36])
    select.pluck()
    expect(select.get()).toBe('ada')
  })

  it('a statement that returns no data refuses pluck, raw, expand and columns, and a non-boolean toggle', () => {
    const db = seeded()
    const update = db.prepare('UPDATE people SET age = 1')
    for (const method of ['pluck', 'raw', 'expand', 'columns'] as const) {
      expect(() => update[method](), method).toThrow(new TypeError(`The ${method}() method is only for statements that return data`))
    }
    expect(() => db.prepare('SELECT 1').pluck('yes' as never)).toThrow(new TypeError('Expected first argument to be a boolean'))
  })

  it('columns describes each column, in better-sqlite3\'s key order', () => {
    const columns = seeded().prepare('SELECT name AS who, 1 AS one FROM people').columns()
    expect(columns).toEqual([
      { name: 'who', column: 'name', table: 'people', database: 'main', type: 'TEXT' },
      { name: 'one', column: null, table: null, database: null, type: null }
    ])
    expect(Object.keys(columns[0] as object)).toEqual(['name', 'column', 'table', 'database', 'type'])
  })
})

describe('properties', () => {
  it('source, reader, readonly and database', () => {
    const db = people()
    const select = db.prepare('SELECT * FROM people')
    const insert = db.prepare('INSERT INTO people (name) VALUES (?)')
    expect(select.source).toBe('SELECT * FROM people')
    expect([select.reader, select.readonly, insert.reader, insert.readonly]).toEqual([true, true, false, false])
    expect(db.prepare('INSERT INTO people (name) VALUES (?) RETURNING id').reader).toBe(true)
    expect(select.database).toBe(db)
  })

  it('an empty or blank statement is a RangeError, and SQL that does not parse is a SqliteError', () => {
    const db = new Database(':memory:')
    expect(() => db.prepare('')).toThrow(new RangeError('The supplied SQL string contains no statements'))
    expect(() => db.prepare(5 as never)).toThrow(new TypeError('Expected first argument to be a string'))
    expect(() => db.prepare('SELEC 1')).toThrow(expect.objectContaining({ name: 'SqliteError', code: 'SQLITE_ERROR' }))
  })
})

describe('errors from a running statement', () => {
  it('a violated constraint is a SqliteError with the extended result code', () => {
    const db = people()
    const insert = db.prepare('INSERT INTO people (name) VALUES (?)')
    insert.run('ada')
    let caught: unknown
    try { insert.run('ada') } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(Database.SqliteError)
    expect(caught).toBeInstanceOf(Error)
    expect(caught).toMatchObject({ name: 'SqliteError', code: 'SQLITE_CONSTRAINT_UNIQUE', message: 'UNIQUE constraint failed: people.name' })
    expect(Object.keys(caught as object)).toEqual(['code'])
  })

  it('other constraint kinds carry their own code', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (p REFERENCES p(id), n NOT NULL)')
    const code = (run: () => unknown): unknown => { try { run() } catch (error) { return (error as { code: string }).code } }
    expect(code(() => db.prepare('INSERT INTO c VALUES (1, 1)').run())).toBe('SQLITE_CONSTRAINT_FOREIGNKEY')
    expect(code(() => db.prepare('INSERT INTO c VALUES (NULL, NULL)').run())).toBe('SQLITE_CONSTRAINT_NOTNULL')
    expect(code(() => db.prepare('SELECT * FROM missing'))).toBe('SQLITE_ERROR')
  })

  it('an error thrown while iterating is a SqliteError, and the statement is usable afterwards', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE t (n)')
    db.exec('INSERT INTO t VALUES (1), (0)')
    const select = db.prepare('SELECT abs(-9223372036854775807 - 1 - n) AS v FROM t')
    expect(() => [...select.iterate()]).toThrow(expect.objectContaining({ name: 'SqliteError' }))
    expect(db.prepare('SELECT 1 AS one').get()).toEqual({ one: 1 })
  })

  it('a statement used after its database closed is a TypeError', () => {
    const db = new Database(':memory:')
    const select = db.prepare('SELECT 1')
    db.close()
    expect(() => select.get()).toThrow(new TypeError('The database connection is not open'))
  })
})
