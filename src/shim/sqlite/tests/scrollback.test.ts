// The statements of a chat client's scrollback store -- the schema, its
// migration inside BEGIN EXCLUSIVE, `insert ... returning`, JSON search with
// LIKE ... ESCAPE, a bounded delete through a subquery, VACUUM after COMMIT --
// run on this module and on Node's own node:sqlite with the same input.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync as NodeDatabaseSync } from 'node:sqlite'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from '../database.js'
import { loadTestEngine } from './support/engine.js'
import { createMemorySyncFs, type MemorySyncFs } from './support/memory-sync-fs.js'

const SCHEMA = [
  'CREATE TABLE options (name TEXT, value TEXT, CONSTRAINT name_unique UNIQUE (name))',
  'CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, network TEXT, channel TEXT, time INTEGER, type TEXT, msg TEXT)',
  `CREATE TABLE migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version INTEGER NOT NULL UNIQUE,
    rollback_forbidden INTEGER DEFAULT 0 NOT NULL
  )`,
  `CREATE TABLE rollback_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    migration_id INTEGER NOT NULL REFERENCES migrations ON DELETE CASCADE,
    step INTEGER NOT NULL,
    statement TEXT NOT NULL
  )`,
  'CREATE INDEX time ON messages (time)',
  'CREATE INDEX msg_type_idx on messages (type)',
  'CREATE INDEX network_channel_time ON messages (network, channel, time)'
]

interface Database {
  exec (sql: string): void
  prepare (sql: string): { run (...args: never[]): { changes: number | bigint }, get (...args: never[]): unknown, all (...args: never[]): unknown[] }
  close (): void
}

/** Everything the store does, in order, returning what each read saw. */
function scrollback (db: Database): unknown[] {
  const seen: unknown[] = []
  const haveOptions = (): unknown => db.prepare("select 1 from sqlite_master where type = 'table' and name = 'options'").get()
  seen.push(haveOptions())

  db.exec('BEGIN EXCLUSIVE TRANSACTION')
  try {
    for (const statement of SCHEMA) db.exec(statement)
    db.prepare("INSERT INTO options (name, value) VALUES ('schema_version', ?)").run('1780272000000' as never)
    for (const [version, forbidden] of [[1672236339873, 0], [1780272000000, 1]] as const) {
      const migration = db.prepare('insert into migrations\n(version, rollback_forbidden)\nvalues (?, ?)\nreturning id').get(version as never, forbidden as never) as { id: number }
      seen.push(migration)
      let step = 0
      for (const statement of ['DROP INDEX IF EXISTS network_channel_time', 'CREATE INDEX IF NOT EXISTS network_channel ON messages (network, channel)']) {
        db.prepare('insert into rollback_steps\n(migration_id, step, statement)\nvalues (?, ?, ?)').run(migration.id as never, step++ as never, statement as never)
      }
    }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  db.exec('COMMIT')
  db.exec('VACUUM')
  seen.push(haveOptions(), db.prepare("SELECT value FROM options WHERE name = 'schema_version'").get())

  const insert = db.prepare('INSERT INTO messages(network, channel, time, type, msg) VALUES(?, ?, ?, ?, ?)')
  db.exec('BEGIN')
  for (let i = 0; i < 300; i++) {
    const text = i % 7 === 0 ? `100% sure_thing ${String(i)}` : `hello ${String(i)}`
    insert.run('uuid-1' as never, (i % 3 === 0 ? '#a' : '#b') as never, (1_700_000_000_000 + i * 1000) as never,
      (i % 5 === 0 ? 'join' : 'message') as never, JSON.stringify({ text, from: { nick: `n${String(i % 4)}` } }) as never)
  }
  db.exec('COMMIT')
  seen.push(db.prepare('SELECT msg, type, time FROM messages WHERE network = ? AND channel = ? ORDER BY time DESC, id DESC LIMIT ?').all('uuid-1' as never, '#a' as never, 3 as never))

  const term = '100% sure_'.replace(/([%_@])/g, '@$1')
  seen.push(db.prepare("SELECT msg, type, time, network, channel FROM messages WHERE type = 'message' AND json_extract(msg, '$.text') LIKE ? ESCAPE '@' AND network = ?  AND channel = ?  ORDER BY time DESC, id DESC LIMIT ? OFFSET ? ")
    .all(`%${term}%` as never, 'uuid-1' as never, '#a' as never, 100 as never, 0 as never))

  const types = ['join', 'part']
  const sql = `delete from messages where id in (select id from messages where\ntime <= ?\nand type in (${types.map(() => '?').join(',')})\norder by time asc\nlimit ?\n)`
  seen.push(db.prepare(sql).run(1_700_000_100_000 as never, ...types as never[], 1000 as never).changes)
  seen.push(db.prepare('select count(*) as n, min(time) as first from messages').get())
  seen.push(db.prepare('delete from messages where network = ? and channel = ?').run('uuid-1' as never, '#b' as never).changes)

  db.exec('BEGIN EXCLUSIVE TRANSACTION')
  db.prepare('delete from migrations where migrations.version > ?').run(1672236339873 as never)
  db.exec('ROLLBACK')
  seen.push(db.prepare('select version, rollback_forbidden, statement\nfrom rollback_steps\njoin migrations on migrations.id=rollback_steps.migration_id\nwhere version > ?\norder by version desc, step asc').all(0 as never))
  seen.push(db.prepare('pragma integrity_check').get())
  db.close()
  return seen
}

const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? Number(item) : item))

let fs: MemorySyncFs
let scratch: string

beforeAll(loadTestEngine)
beforeEach(() => { fs = createMemorySyncFs(); fs.install(); scratch = mkdtempSync(join(tmpdir(), 'orivon-sqlite-scrollback-')) })
afterEach(() => { fs.uninstall(); rmSync(scratch, { recursive: true, force: true }) })

describe('a scrollback store', () => {
  it('sees what Node\'s sqlite sees, in a file', () => {
    const mine = scrollback(new DatabaseSync('/orivon/app/logs/user.sqlite3') as unknown as Database)
    const theirs = scrollback(new NodeDatabaseSync(join(scratch, 'user.sqlite3')) as unknown as Database)
    expect(normalize(mine)).toEqual(normalize(theirs))
    expect(fs.files.has('logs/user.sqlite3-journal')).toBe(false)
  })

  it('sees what Node\'s sqlite sees, in memory', () => {
    expect(normalize(scrollback(new DatabaseSync(':memory:') as unknown as Database))).toEqual(normalize(scrollback(new NodeDatabaseSync(':memory:') as unknown as Database)))
  })

  it('a failed migration rolls back to an empty database', () => {
    const db = new DatabaseSync('/orivon/app/logs/user.sqlite3')
    db.exec('BEGIN EXCLUSIVE TRANSACTION')
    db.exec(SCHEMA[0] as string)
    expect(() => db.exec('CREATE TABLE options (x)')).toThrow(expect.objectContaining({ code: 'ERR_SQLITE_ERROR' }))
    db.exec('ROLLBACK')
    expect(db.prepare("select 1 from sqlite_master where name = 'options'").get()).toBeUndefined()
    db.close()
  })
})
