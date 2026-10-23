// Bundled against the shim by ./e2e-sqlite.test.ts as the app's /sqlite-child.js,
// the way a server ported from Node would be: it imports the shim's ready module
// first, then requires `node:sqlite` as CommonJS code does.

import '../../src/shim/sqlite/ready.js'
import { mkdirSync } from 'fs'
import Database from '../../src/shim/sqlite/better-sqlite3.js'

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

/** What the `better-sqlite3` API does with a function the app registers and with `backup`, on a database in the app's files. */
async function userFunctionsAndBackup (): Promise<unknown> {
  const db = new Database('/orivon/app/data/functions.sqlite3')
  db.function('regexp', { deterministic: true }, (pattern: unknown, text: unknown) => new RegExp(String(pattern), 'u').test(String(text)) ? 1 : 0)
  db.function('fold', { deterministic: true }, (text: unknown) => String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase())
  db.function('boom', () => { throw new RangeError('from the function') })
  db.exec('create table words (w text); create index words_fold on words (fold(w))')
  const insert = db.prepare('insert into words values (?)')
  for (const word of ['b\u00e9ta', 'alpha', 'Beta', '\u00c9clair', 'bravo']) insert.run(word)
  const matched = db.prepare("select w from words where w regexp '^b' order by fold(w)").pluck().all()
  const folded = db.prepare("select w from words where fold(w) = 'eclair'").pluck().all()
  const thrown = outcome(() => db.prepare('select boom()').get())
  const copied = await db.backup('/orivon/app/data/functions-copy.sqlite3')
  db.prepare('insert into words values (?)').run('after the backup')
  const copy = new Database('/orivon/app/data/functions-copy.sqlite3', { readonly: true })
  const copiedRows = copy.prepare('select count(*) from words').pluck().get()
  copy.close()
  const outside = await Promise.all(['../functions-escape.sqlite3', '/functions-escape.sqlite3'].map(async (path) => await db.backup(path).then(() => 'resolved', (error: Error) => error.name)))
  db.close()
  const node = new DatabaseSync('/orivon/app/data/functions-node.sqlite3')
  node.function('twice', { deterministic: true }, (value: unknown) => (value as number) * 2)
  const twice = node.prepare('select twice(21) as v').get()
  node.close()
  return { matched, folded, thrown, pages: copied.totalPages, copiedRows, outside, twice }
}

process.on('message', () => {
  void (async () => {
    const base = outcome(scenario)
    if ('value' in base) Object.assign(base.value as object, { userFunctions: await userFunctionsAndBackup().catch((error: unknown) => ({ failed: String((error as Error)?.stack ?? error) })) })
    process.send?.(base)
  })()
})
