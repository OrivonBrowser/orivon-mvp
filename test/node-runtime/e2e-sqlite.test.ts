// node:sqlite end to end: a forked child of a cross-origin isolated app opens a
// database in the app's files -- through the shim's VFS, the Worker's synchronous
// file calls and the real broker -- writes, closes, reopens and reads it, with the
// engine's WebAssembly fetched by the child's own bundle under the served CSP.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && npx vitest run --config test/vitest.e2e.config.ts test/node-runtime/e2e-sqlite.test.ts
import { afterAll, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER } from '../support/smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase, waitForPageGlobal } from '../support/e2e-helpers.js'
import { bundleForApp, serveApp } from './pinned-app.js'
import type { SqliteResults } from './sqlite-entry.js'
import type { Manifest } from '../../src/contracts/index.js'

const ORIGIN = 'https://sqlite-e2e.orivon.test'
const MANIFEST: Manifest = {
  orivonApiVersion: 0,
  id: 'app.orivon.sqlite-e2e',
  name: 'node:sqlite e2e fixture',
  version: '1.0.0',
  entry: 'index.html',
  assets: ['app.js', 'sqlite-child.js', 'sqlite3.wasm'],
  crossOriginIsolated: true,
  capabilities: { fs: { quotaBytes: 8_388_608 } }
}

interface UserFunctions {
  matched?: unknown
  folded?: unknown
  thrown?: { error?: { name?: string } }
  copiedRows?: unknown
  pages?: number
  outside?: unknown
  twice?: unknown
  failed?: string
}

interface FromBytes {
  opened?: { name?: string, memory?: boolean, rows?: number }
  afterDelete?: number
  copiedRows?: number
  serializedRows?: number
  fileUnchanged?: boolean
  serializedStart?: string
  notDatabase?: { code?: string } | string
  files?: readonly string[]
  failed?: string
}

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:node-sqlite-in-worker] [app:node-fs-writes-land-at-app-root] [app:sqlite-user-functions] [app:sqlite-backup-to-app-files] [app:sqlite-database-from-bytes] a forked child opens, writes, closes, reopens and reads a database file in the app\'s files, calls a function the app registered, backs the database up, and opens a database from bytes', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    await runPhase('node:sqlite', async (check) => {
      const html = '<!doctype html><html><head><title>sqlite fixture</title><script src="/app.js"></script></head><body><h1>sqlite fixture</h1></body></html>'
      const wasm = readFileSync(createRequire(import.meta.url).resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm'))
      const served = await serveApp(app, ORIGIN, MANIFEST, 'fs', {
        '/index.html': new TextEncoder().encode(html),
        '/app.js': await bundleForApp(fileURLToPath(new URL('./sqlite-entry.ts', import.meta.url))),
        '/sqlite-child.js': await bundleForApp(fileURLToPath(new URL('./sqlite-fork-entry.ts', import.meta.url)), 'esm'),
        '/sqlite3.wasm': new Uint8Array(wasm)
      })
      check('the fixture is granted fs and registered for serving', served.granted && served.registered, JSON.stringify(served))

      const view = await navigateToFixture(app, `${ORIGIN}/`, 'sqlite fixture')
      await waitForPageGlobal(view, 'sqliteE2e')
      const results = await evaluateRetrying(view, async () => await (globalThis as unknown as { sqliteE2e: { run: () => Promise<SqliteResults> } }).sqliteE2e.run(), 60_000)
      const detail = JSON.stringify(results)
      const reply = (results.reply ?? {}) as { value?: { isolated?: boolean, counted?: number, integrity?: unknown, location?: string, inMemory?: unknown, duplicate?: { error?: { code?: string, errcode?: number } }, backup?: { error?: { name?: string } }, userFunctions?: UserFunctions, fromBytes?: FromBytes }, error?: unknown }

      check('the page ran the case without throwing', results.error === undefined && reply.error === undefined, detail)
      check('the child is cross-origin isolated', reply.value?.isolated === true, detail)
      check('the rows written before the close are there after the reopen', reply.value?.counted === 300, detail)
      check('the reopened database passes its integrity check', JSON.stringify(reply.value?.integrity) === JSON.stringify({ integrity_check: 'ok' }), detail)
      check('location() is the path given', reply.value?.location === '/orivon/app/data/scrollback.sqlite3', detail)
      check('an in-memory database works beside it', JSON.stringify(reply.value?.inMemory) === JSON.stringify({ v: 2 }), detail)
      check('a unique violation carries Node\'s error shape', reply.value?.duplicate?.error?.code === 'ERR_SQLITE_ERROR' && reply.value.duplicate.error.errcode === 2067, detail)
      check('backup refuses by name', reply.value?.backup?.error?.name === 'OrivonShimError', detail)
      check('the page reads a real SQLite file from the app\'s files', results.fileStart === 'SQLite format 3' && (results.fileBytes ?? 0) > 60_000, detail)
      check('no journal is left beside it', results.journalLeft === false, detail)

      const functions = reply.value?.userFunctions
      check('the child ran the functions case without failing', functions !== undefined && functions.failed === undefined, detail)
      check('a function the app registered backs a WHERE clause and an expression index', JSON.stringify(functions?.matched) === JSON.stringify(['b\u00e9ta', 'bravo']) && JSON.stringify(functions?.folded) === JSON.stringify(['\u00c9clair']), detail)
      check('node:sqlite registers a function the same way', JSON.stringify(functions?.twice) === JSON.stringify({ v: 42 }), detail)
      check('an exception in a function fails its statement and reaches the caller', functions?.thrown?.error?.name === 'RangeError', detail)
      check('backup resolves after a copy of the database is in the app\'s files', (functions?.pages ?? 0) > 1 && functions?.copiedRows === 5 && results.copyStart === 'SQLite format 3', detail)
      const dataFiles: readonly string[] = results.dataFiles ?? []
      check('backup leaves no temporary file in the app\'s files', dataFiles.every((name) => !name.includes('.backup-')) && dataFiles.includes('functions-copy.sqlite3'), detail)
      check('backup to a place outside the app\'s files is refused', Array.isArray(functions?.outside) && functions.outside.length === 2 && functions.outside.every((outcome) => outcome !== 'resolved'), detail)

      const bytes = reply.value?.fromBytes
      check('the child ran the from-bytes case without failing', bytes !== undefined && bytes.failed === undefined, detail)
      check('the bytes of a database file open as a database in memory', bytes?.opened?.name === ':memory:' && bytes.opened.memory === true && bytes.opened.rows === 6, detail)
      check('a change to that database reaches a backup and not the file it came from', bytes?.afterDelete === 2 && bytes.copiedRows === 2 && bytes.fileUnchanged === true, detail)
      check('serialize gives bytes that a database opened by path reads', bytes?.serializedStart === 'SQLite format 3' && bytes.serializedRows === 2, detail)
      check('bytes that are not a database fail at the first statement with file is not a database', typeof bytes?.notDatabase === 'object' && bytes.notDatabase.code === 'SQLITE_NOTADB', detail)
      check('opening from bytes made no file of its own', JSON.stringify(bytes?.files) === JSON.stringify(['from-bytes-copy.sqlite3', 'from-bytes-serialized.sqlite3', 'from-bytes.sqlite3']), detail)
    })
  } finally {
    await closeElectronApp(app)
  }
}, 240_000)
