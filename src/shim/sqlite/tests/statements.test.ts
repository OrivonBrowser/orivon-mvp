// The statement surface, each case run against Node's own node:sqlite and this
// module on the same input: results and errors must be the same.

import { DatabaseSync as NodeDatabaseSync, constants as nodeConstants } from 'node:sqlite'
import { beforeAll, describe, expect, it } from 'vitest'
import { constants } from '../constants.js'
import { DatabaseSync } from '../database.js'
import { collectGarbage } from '../../tests/support/collect-garbage.js'
import { loadTestEngine } from './support/engine.js'

beforeAll(loadTestEngine)

type Database = DatabaseSync | NodeDatabaseSync

function outcome (run: () => unknown): unknown {
  try {
    const value = run()
    return { value: JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? `${item.toString()}n` : item instanceof Uint8Array ? [...item] : item)) as unknown }
  } catch (error) {
    const { name, message, code, errcode, errstr } = error as Record<string, unknown>
    return { error: { name, message, code, errcode, errstr } }
  }
}

/** Runs `scenario` on a fresh in-memory database of each implementation and expects the same outcome. */
function same (label: string, scenario: (db: Database) => unknown, options?: object): void {
  it(label, () => {
    const mine = outcome(() => scenario(options === undefined ? new DatabaseSync(':memory:') : new DatabaseSync(':memory:', options)))
    const theirs = outcome(() => scenario(options === undefined ? new NodeDatabaseSync(':memory:') : new NodeDatabaseSync(':memory:', options)))
    expect(mine).toEqual(theirs)
  })
}

const SETUP = 'CREATE TABLE t (id INTEGER PRIMARY KEY, a, b TEXT UNIQUE, c REAL, d BLOB)'

describe('run', () => {
  same('reports changes and the last row id', (db) => {
    db.exec(SETUP)
    return [
      db.prepare('INSERT INTO t (a,b,c,d) VALUES (?,?,?,?)').run(1, 'x', 1.5, new Uint8Array([1, 2])),
      db.prepare('INSERT INTO t (a,b) VALUES (:a,$b)').run({ a: 5n, b: 'y' }),
      db.prepare('INSERT INTO t (b) VALUES (?), (?), (?)').run('p', 'q', 'r'),
      db.prepare('DELETE FROM t').run()
    ]
  })
  same('a statement that returns rows reports no change', (db) => db.prepare('select 1').run())
  same('a unique violation carries the errcode and errstr', (db) => {
    db.exec(SETUP)
    db.prepare('INSERT INTO t (b) VALUES (?)').run('x')
    return db.prepare('INSERT INTO t (b) VALUES (?)').run('x')
  })
  same('bigints in results when asked, on the database', (db) => {
    db.exec(SETUP)
    return db.prepare('INSERT INTO t (b) VALUES (?)').run('x')
  }, { readBigInts: true })
})

describe('get, all and iterate', () => {
  same('a row has the column names and Node\'s value types', (db) => {
    db.exec(SETUP)
    db.prepare('INSERT INTO t (a,b,c,d) VALUES (?,?,?,?)').run(1, 'x', 1.5, new Uint8Array([1, 2]))
    db.prepare('INSERT INTO t (a,b) VALUES (?,?)').run('text', 'y')
    return [db.prepare('select * from t').get(), db.prepare('select * from t').all(), db.prepare('select * from t where id = 99').get()]
  })
  same('iterate yields the rows in order', (db) => {
    db.exec('create table q (x)')
    db.exec('insert into q values (1),(2),(3)')
    return [...db.prepare('select x from q order by x').iterate()]
  })
  same('returnArrays gives arrays', (db) => {
    db.exec('create table q (x, y)')
    db.exec("insert into q values (1,'a'),(2,'b')")
    return db.prepare('select x, y from q').all()
  }, { returnArrays: true })
  same('duplicate column names keep the last', (db) => db.prepare('select 1 as a, 2 as a').get())
  same('the null prototype is not visible to JSON', (db) => db.prepare("select 'é' as s, x'00ff' as b, null as n").get())
  it('a row has no prototype', () => {
    const db = new DatabaseSync(':memory:')
    expect(Object.getPrototypeOf(db.prepare('select 1 as a').get())).toBeNull()
  })
  it('a blob is a Uint8Array and a text with a NUL keeps it', () => {
    const db = new DatabaseSync(':memory:')
    const row = db.prepare("select x'0102' as b, 'a' || char(0) || 'b' as s").get() as { b: unknown, s: string }
    expect(row.b).toBeInstanceOf(Uint8Array)
    expect(row.s).toBe('a\u0000b')
  })
})

describe('binding', () => {
  same('a number binds as REAL, a bigint as INTEGER', (db) => [db.prepare('select typeof(?) as t').get(1), db.prepare('select typeof(?) as t').get(1n)])
  same('null, strings and blobs round trip, including empty ones', (db) => [
    db.prepare('select ? as a, ? as b, ? as c, ? as d, typeof(?) as e').get(null, 'héllo 😀', new Uint8Array([9, 8]), '', new Uint8Array(0))
  ])
  same('a typed array other than Uint8Array binds its bytes', (db) => db.prepare('select ? as b').get(new Uint16Array([1, 2])))
  // Node before 24.21 refuses a boolean and later Nodes bind it as 1 or 0, so this asserts the
  // shim's behaviour (the later one) directly instead of comparing with the running Node.
  it('a boolean binds as 1 or 0', () => {
    const db = new DatabaseSync(':memory:')
    const statement = db.prepare('select ? as a, ? as b')
    expect(statement.get(true as never, false as never)).toEqual({ a: 1, b: 0 })
    expect(db.prepare('select :t as t').get({ t: true as never })).toEqual({ t: 1 })
  })
  same('undefined cannot be bound', (db) => db.prepare('select ?').get(undefined as never))
  same('too many parameters', (db) => db.prepare('select ?').get(1, 2))
  same('too few parameters bind NULL', (db) => db.prepare('select ? as x').get())
  same('a bigint outside 64 bits', (db) => db.prepare('select ? as n').get(2n ** 64n))
  same('bare named parameters', (db) => db.prepare('select :a as a, @b as b, $c as c').get({ a: 1, b: 2, c: 3 }))
  same('prefixed named parameters', (db) => db.prepare('select :a as a').get({ ':a': 1 }))
  same('an unknown named parameter', (db) => db.prepare('select :a as a').get({ a: 1, z: 2 }))
  same('unknown named parameters may be allowed', (db) => db.prepare('select :a as a').get({ a: 1, z: 2 }), { allowUnknownNamedParameters: true })
  same('bare names may be refused', (db) => db.prepare('select :a as a').get({ a: 1 }), { allowBareNamedParameters: false })
  same('named and anonymous parameters mix', (db) => db.prepare('select :a as a, ? as p, ? as q').get({ a: 1 }, 2, 3))
  same('bindings do not leak into the next call', (db) => {
    const statement = db.prepare('select ? as x')
    return [statement.get(5), statement.get()]
  })
})

describe('integers', () => {
  same('a value beyond 2^53 is an error unless bigints are read', (db) => db.prepare('select 9007199254740993 as n').get())
  same('the largest safe integer is a number', (db) => db.prepare('select 9007199254740991 as n').get())
  same('a 2^62 bigint round trips as a bigint', (db) => db.prepare('select ? as n').get(2n ** 62n), { readBigInts: true })
  same('setReadBigInts on one statement', (db) => {
    const statement = db.prepare('select 9007199254740993 as n')
    statement.setReadBigInts(true)
    return statement.get()
  })
  same('setReadBigInts wants a boolean', (db) => db.prepare('select 1').setReadBigInts(1 as never))
})

describe('sourceSQL, expandedSQL and columns', () => {
  same('sourceSQL keeps the text as given', (db) => db.prepare('select ?  as x').sourceSQL)
  same('expandedSQL shows the bound values', (db) => {
    const statement = db.prepare('select ? as x, ? as y')
    statement.get(5, 'it\'s')
    return statement.expandedSQL
  })
  same('columns names each column', (db) => {
    db.exec(SETUP)
    return db.prepare('select id as x, a, b from t').columns()
  })
})

describe('the connection', () => {
  same('a syntax error', (db) => db.exec('SELEC'))
  same('a syntax error at prepare', (db) => db.prepare('SELEC'))
  same('a missing table', (db) => db.prepare('select * from nope'))
  same('exec runs several statements', (db) => { db.exec('create table q(x); insert into q values (1); insert into q values (2);'); return db.prepare('select count(*) as n from q').get() })
  same('isTransaction follows BEGIN and COMMIT', (db) => {
    const seen = [db.isTransaction]
    db.exec('BEGIN')
    seen.push(db.isTransaction)
    db.exec('COMMIT')
    seen.push(db.isTransaction)
    return seen
  })
  same('the location of an in-memory database', (db) => db.location())
  same('foreign keys are on by default', (db) => db.prepare('pragma foreign_keys').get())
  same('foreign keys may be off', (db) => db.prepare('pragma foreign_keys').get(), { enableForeignKeyConstraints: false })
  same('a foreign key violation', (db) => {
    db.exec('create table p (id integer primary key); create table c (p integer references p(id))')
    return db.prepare('insert into c values (1)').run()
  })
  same('double-quoted strings are refused by default', (db) => db.prepare('select "abc" as v').get())
  same('double-quoted strings may be allowed', (db) => db.prepare('select "abc" as v').get(), { enableDoubleQuotedStringLiterals: true })
  same('JSON functions are present', (db) => db.prepare("select json_extract('{\"a\":[1,2]}', '$.a[1]') as v").get())
  same('sql must be a string', (db) => db.exec(5 as never))
  // Node before 24.21 prepares an empty statement to a finalized one; later Nodes refuse it at
  // prepare. The shim follows the later behaviour, asserted directly for the same reason as the
  // boolean binding above.
  it('an empty statement is refused when prepared', () => {
    const db = new DatabaseSync(':memory:')
    for (const sql of ['', '   ', '-- nothing\n', ';']) {
      const error = outcome(() => db.prepare(sql))
      expect(error).toEqual({ error: expect.objectContaining({ name: 'TypeError', code: 'ERR_INVALID_ARG_VALUE', message: 'The SQL query contains no statements.' }) })
    }
  })
  same('a closed database refuses', (db) => { db.close(); return db.exec('select 1') })
  same('closing twice', (db) => { db.close(); return db.close() })
  same('a statement outlives its database as finalized', (db) => { const statement = db.prepare('select 1'); db.close(); return statement.get() })
  same('isOpen after close', (db) => { const before = db.isOpen; db.close(); return [before, db.isOpen] })
  same('open: false defers opening', (db) => [db.isOpen, (db.open(), db.isOpen)], { open: false })
  same('opening twice', (db) => db.open())

  it('constructor argument errors match Node', () => {
    const mine = [undefined, 5, 'a\0b'].map((path) => outcome(() => new DatabaseSync(path as never)))
    const theirs = [undefined, 5, 'a\0b'].map((path) => outcome(() => new NodeDatabaseSync(path as never)))
    expect(mine).toEqual(theirs)
  })

  it('a statement is not constructible', async () => {
    const { StatementSync } = await import('../index.js')
    const construct = (Class: unknown) => outcome(() => new (Class as new () => unknown)())
    const node = await import('node:sqlite')
    expect(construct(StatementSync)).toEqual(construct(node.StatementSync))
  })

  it('Symbol.dispose closes', () => {
    const db = new DatabaseSync(':memory:')
    db[Symbol.dispose]()
    expect(db.isOpen).toBe(false)
  })
})

it('constants are Node\'s, value for value', () => {
  expect({ ...constants }).toEqual({ ...nodeConstants })
})

describe('members not built refuse by name', () => {
  it.each(['function', 'aggregate', 'createSession', 'applyChangeset', 'createTagStore', 'loadExtension', 'enableLoadExtension'] as const)('%s', (member) => {
    const db = new DatabaseSync(':memory:') as unknown as Record<string, () => void>
    expect(() => db[member]?.()).toThrow(expect.objectContaining({ name: 'OrivonShimError', reason: 'not-built', api: expect.stringContaining('sqlite.DatabaseSync') as string }))
  })
  it('allowExtension', () => {
    expect(() => new DatabaseSync(':memory:', { allowExtension: true })).toThrow(expect.objectContaining({ name: 'OrivonShimError' }))
  })
})

describe('lifetime', () => {
  function prepareOnly (): StatementSyncLike {
    const db = new DatabaseSync(':memory:')
    db.exec('create table t(x); insert into t values (1), (2), (3)')
    return db.prepare('select x from t order by x')
  }
  type StatementSyncLike = ReturnType<DatabaseSync['prepare']>

  it('a statement keeps its database open once nothing else references the database', async () => {
    const statement = prepareOnly()
    await collectGarbage()
    expect(statement.all()).toEqual([{ x: 1 }, { x: 2 }, { x: 3 }])
  })

  it('an iterator keeps its statement and database alive', async () => {
    const iterator = prepareOnly().iterate()
    await collectGarbage()
    expect([...iterator]).toEqual([{ x: 1 }, { x: 2 }, { x: 3 }])
  })

  it('a database nobody references is closed once its statements are gone too', async () => {
    const ref = ((): WeakRef<DatabaseSync> => {
      const db = new DatabaseSync(':memory:')
      db.prepare('select 1').get()
      return new WeakRef(db)
    })()
    await collectGarbage()
    expect(ref.deref()).toBeUndefined()
  })
})
