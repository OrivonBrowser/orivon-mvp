// Bundled against the shim by ./e2e-sqlite.test.ts as the app's /sqlite-child.js,
// the way a server ported from Node would be: it imports the shim's ready module
// first, then requires `node:sqlite` as CommonJS code does.

import '../../src/shim/sqlite/ready.js'
import { mkdirSync } from 'fs'

declare const require: (id: string) => unknown
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')

function outcome<T> (run: () => T): { value: T } | { error: { code?: unknown, errcode?: unknown, name: string } } {
  try {
    return { value: run() }
  } catch (error) {
    const { code, errcode, name } = error as { code?: unknown, errcode?: unknown, name: string }
    return { error: { code, errcode, name } }
  }
}

function scenario (): unknown {
  mkdirSync('/orivon/app/data', { recursive: true })
  const path = '/orivon/app/data/scrollback.sqlite3'
  const first = new DatabaseSync(path)
  first.exec('create table messages (id integer primary key autoincrement, channel text unique, body text)')
  first.exec('begin exclusive transaction')
  const insert = first.prepare('insert into messages (channel, body) values (?, ?)')
  for (let i = 0; i < 300; i++) insert.run(`#c${String(i)}`, 'x'.repeat(200))
  first.exec('commit')
  const duplicate = outcome(() => insert.run('#c1', 'again'))
  first.exec('vacuum')
  first.close()

  const second = new DatabaseSync(path)
  const counted = (second.prepare('select count(*) as n from messages').get() as { n: number }).n
  const integrity = second.prepare('pragma integrity_check').get()
  const location = second.location()
  second.close()

  const memory = new DatabaseSync(':memory:')
  const inMemory = memory.prepare("select json_extract('{\"a\":[1,2]}', '$.a[1]') as v").get()
  memory.close()
  return {
    isolated: crossOriginIsolated,
    counted,
    integrity,
    location,
    inMemory,
    duplicate,
    backup: outcome(() => (require('node:sqlite') as { backup: () => void }).backup())
  }
}

process.on('message', () => {
  process.send?.(outcome(scenario))
})
