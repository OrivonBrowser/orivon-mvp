// What one statement costs in synchronous file calls. Each call is a round
// trip to the page (README.md quotes these numbers); a change to how the
// engine or the VFS spends them has to show up here first.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from '../database.js'
import { createMemorySyncFs, type MemorySyncFs } from './support/memory-sync-fs.js'
import { loadTestEngine } from './support/engine.js'

const DB = '/orivon/app/data/messages.sqlite3'
let fs: MemorySyncFs

beforeAll(loadTestEngine)
beforeEach(() => { fs = createMemorySyncFs(); fs.install() })
afterEach(() => { fs.uninstall() })

function tally (calls: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const call of calls) {
    const kind = call.split(':')[0] ?? call
    counts[kind] = (counts[kind] ?? 0) + 1
  }
  return counts
}

function seeded (): DatabaseSync {
  const db = new DatabaseSync(DB)
  db.exec('create table messages (id integer primary key autoincrement, network text, channel text, time integer, type text, msg text)')
  db.exec('create index network_channel_time on messages (network, channel, time)')
  db.exec('begin')
  const insert = db.prepare('insert into messages (network, channel, time, type, msg) values (?, ?, ?, ?, ?)')
  for (let i = 0; i < 200; i++) insert.run('n', '#c', i, 'message', 'x'.repeat(100))
  db.exec('commit')
  return db
}

const INSERT = 'insert into messages (network, channel, time, type, msg) values (?, ?, ?, ?, ?)'

describe('the cost of a statement, in synchronous file calls', () => {
  it('one committed INSERT: journal created, synced, database pages written, journal removed', () => {
    const db = seeded()
    fs.calls.length = 0
    db.prepare(INSERT).run('n', '#c', 999, 'message', 'hello')
    expect(tally(fs.calls)).toEqual({ read: 2, open: 1, write: 5, sync: 3, close: 1, rm: 1 })
    expect(fs.calls.length).toBe(13)
    db.close()
  })

  it('one committed INSERT with the connection\'s locking mode exclusive', () => {
    const db = seeded()
    db.exec('pragma locking_mode = exclusive')
    db.prepare(INSERT).run('n', '#c', 999, 'message', 'warm')
    fs.calls.length = 0
    db.prepare(INSERT).run('n', '#c', 999, 'message', 'hello')
    expect(tally(fs.calls)).toEqual({ write: 5, read: 1, sync: 4 })
    db.close()
  })

  it('a SELECT on a warm cache is one read: the check that no one else changed the file', () => {
    const db = seeded()
    const select = db.prepare('select msg from messages where network = ? and channel = ? and time = ?')
    select.get('n', '#c', 150)
    fs.calls.length = 0
    select.get('n', '#c', 150)
    expect(fs.calls).toEqual(['read'])
    db.close()
  })

  it('a SELECT on a cold cache reads only the pages it needs', () => {
    const db = seeded()
    db.exec('pragma cache_size = 1')
    fs.calls.length = 0
    db.prepare('select msg from messages where network = ? and channel = ? and time = ?').get('n', '#c', 150)
    expect(tally(fs.calls)).toEqual({ read: 4 })
    db.close()
  })

  it('opening an existing database', () => {
    seeded().close()
    fs.calls.length = 0
    const db = new DatabaseSync(DB)
    db.close()
    // A failed exclusive create, then the open that takes the existing file.
    expect(tally(fs.calls)).toEqual({ open: 2, read: 1, close: 1 })
  })
})
