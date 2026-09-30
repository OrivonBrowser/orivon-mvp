// The Worker end of worker.test.ts, in a real worker_threads thread that
// blocks in Atomics.wait for every file call: a database opened, written,
// closed and reopened through the shim's `node:sqlite` module.

import { readFileSync } from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'
import { mkdirSync } from '../../../fs/fs.js'
import { createOrivonClient } from '../../../worker/orivon-client.js'
import { loadSqliteEngine } from '../../engine.js'
import { DatabaseSync } from '../../index.js'

const { port, wasmPath } = workerData as { port: MessagePort, wasmPath: string }
await loadSqliteEngine({ wasmBinary: readFileSync(wasmPath) })
;(globalThis as unknown as { orivon: unknown }).orivon = createOrivonClient(port)

mkdirSync('/orivon/app/data', { recursive: true })
const path = '/orivon/app/data/scrollback.sqlite3'
const first = new DatabaseSync(path)
first.exec('create table messages (id integer primary key autoincrement, network text, channel text, time integer, msg text)')
first.exec('begin exclusive transaction')
const insert = first.prepare('insert into messages (network, channel, time, msg) values (?, ?, ?, ?)')
for (let i = 0; i < 500; i++) insert.run('net', '#chan', 1000 + i, `message ${String(i)} ${'x'.repeat(100)}`)
first.exec('commit')
first.exec('vacuum')
first.close()

const second = new DatabaseSync(path)
const counted = second.prepare('select count(*) as n from messages').get() as { n: number }
const last = second.prepare('select msg from messages order by time desc, id desc limit 1').get() as { msg: string }
const integrity = second.prepare('pragma integrity_check').get()
second.close()

parentPort?.postMessage({ counted: counted.n, last: last.msg.slice(0, 12), integrity })
