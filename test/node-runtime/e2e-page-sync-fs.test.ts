// The page's synchronous path-based fs calls (mkdirSync, writeFileSync, copyFileSync, statSync, readdirSync,
// renameSync, readFileSync, rmSync) work through a bundled shim over the broker's blocking channel: the symbol-keyed
// synchronous twin reaches the page's main world, what the calls write is what the async reads see, a write past the
// declared quota is refused on the same ledger, and a handle-based call still refuses by name.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/node-runtime/e2e-page-sync-fs.test.ts
import { afterAll, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER } from '../support/smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase, waitForPageGlobal } from '../support/e2e-helpers.js'
import { bundleForApp, serveApp } from './pinned-app.js'
import type { PageSyncFsResults } from './page-sync-fs-entry.js'
import type { Manifest } from '../../src/contracts/index.js'

const ORIGIN = 'https://page-sync-fs-e2e.orivon.test'
const MANIFEST: Manifest = {
  orivonApiVersion: 0,
  id: 'app.orivon.page-sync-fs-e2e',
  name: 'page synchronous fs e2e fixture',
  version: '1.0.0',
  entry: 'index.html',
  assets: ['app.js'],
  capabilities: { fs: { quotaBytes: 65_536 } }
}

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:page-sync-fs-writes-land] the page makes synchronous path-based fs calls that land in the app\'s files, under its quota', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    await runPhase('page synchronous fs', async (check) => {
      const html = '<!doctype html><html><head><title>page sync fs fixture</title><script src="/app.js"></script></head><body><h1>page sync fs fixture</h1></body></html>'
      const served = await serveApp(app, ORIGIN, MANIFEST, 'fs', {
        '/index.html': new TextEncoder().encode(html),
        '/app.js': await bundleForApp(fileURLToPath(new URL('./page-sync-fs-entry.ts', import.meta.url)))
      })
      check('the fixture is granted fs and registered for serving', served.granted && served.registered, JSON.stringify(served))

      const view = await navigateToFixture(app, `${ORIGIN}/`, 'page sync fs fixture')
      await waitForPageGlobal(view, 'pageSyncFsE2e')
      const results = await evaluateRetrying(view, async () => await (globalThis as unknown as { pageSyncFsE2e: { run: () => Promise<PageSyncFsResults> } }).pageSyncFsE2e.run(), 60_000)
      const detail = JSON.stringify(results)

      check('the page ran the case without throwing', results.error === undefined, detail)
      check('the synchronous twin reached the page\'s main world', results.twinReachesPage === true, detail)
      check('it has the seven path-based members and no open', JSON.stringify(results.twinMembers) === JSON.stringify(['mkdir', 'readFile', 'readdir', 'rename', 'rm', 'stat', 'writeFile']), detail)
      check('statSync sees the file writeFileSync made', results.ops?.['stat'] === 5, detail)
      check('readdirSync lists what mkdirSync, writeFileSync and copyFileSync made', JSON.stringify(results.ops?.['readdir']) === JSON.stringify(['b', 'copy.txt']), detail)
      check('copyFileSync and renameSync moved the bytes', results.ops?.['read'] === 'hello', detail)
      check('existsSync follows the rename', JSON.stringify(results.ops?.['exists']) === JSON.stringify([true, false]), detail)
      check('an existing directory is EEXIST and a missing path ENOENT, as in Node', results.ops?.['mkdirExisting'] === 'EEXIST' && results.ops['statMissing'] === 'ENOENT', detail)
      check('the async reads see every synchronous write', results.asyncSees?.['note'] === 'hello' && results.asyncSees['moved'] === 'hello' && results.asyncSees['promisesRead'] === 'hello' &&
        JSON.stringify(results.asyncSees['dir']) === JSON.stringify(['b', 'moved.txt']), detail)
      check('rmSync removed the tree', results.ops?.['removed'] === true, detail)
      check('a synchronous write past the quota is refused as limit and nothing lands', results.quota?.orivonCode === 'limit' && results.quota.landed === false, detail)
      check('a handle-based call refuses by name', results.openSync?.code === 'ERR_ORIVON_FS_SYNC_UNSUPPORTED', detail)
    })
  } finally {
    await closeElectronApp(app)
  }
}, 240_000)
