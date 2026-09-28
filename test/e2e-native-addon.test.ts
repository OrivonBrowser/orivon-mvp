// Native addons end to end in a real app tab: each addon's WebAssembly build
// sits beside its .node path in the pinned bundle and loads through emnapi.
// On the page, a small one loads synchronously through createRequire and
// process.dlopen; one over Chromium's 8 MB limit on synchronous compiles
// refuses with the advice to preload, then loads after preloadAddon; a
// missing one is ERR_DLOPEN_FAILED. A forked child loads the large one
// synchronously, since a Worker has no such limit. In a cross-origin isolated
// app, an addon's file calls refuse on the page and reach the app's files
// from a forked child, whose readFileSync works too.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && npx vitest run --config test/vitest.e2e.config.ts test/e2e-native-addon.test.ts
import { afterAll, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER } from './smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase } from './e2e-helpers.js'
import { bundleForApp, serveApp } from './pinned-app.js'
import type { NativeAddonResults } from './native-addon-entry.js'
import type { NativeAddonFileResults } from './native-addon-files-entry.js'
import { fileAddon, napiAddon } from '../src/shim/addon/tests/support/napi-addons.js'
import type { Manifest } from '../src/contracts/index.js'

const ORIGIN = 'https://native-addon-e2e.orivon.test'
const ISOLATED_ORIGIN = 'https://native-addon-files-e2e.orivon.test'
const NOSYS = 52
const OVER_SYNC_LIMIT = 9 * 1024 * 1024

const MANIFEST: Manifest = {
  orivonApiVersion: 0,
  id: 'app.orivon.native-addon-e2e',
  name: 'native addon e2e fixture',
  version: '1.0.0',
  entry: 'index.html',
  assets: ['app.js', 'addon-child.js', 'native/answer.wasm', 'native/big.wasm32-wasi.wasm'],
  capabilities: { fs: { quotaBytes: 1_048_576 } }
}

const ISOLATED_MANIFEST: Manifest = {
  orivonApiVersion: 0,
  id: 'app.orivon.native-addon-files-e2e',
  name: 'native addon files e2e fixture',
  version: '1.0.0',
  entry: 'index.html',
  assets: ['app.js', 'files-child.js', 'native/files.wasm'],
  capabilities: { fs: { quotaBytes: 1_048_576 } },
  crossOriginIsolated: true
}

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('loads native addons as their WebAssembly builds on the page and in a forked child', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    await runPhase('native addons', async (check) => {
      const html = '<!doctype html><html><head><title>native addon fixture</title><script src="/app.js"></script></head><body><h1>native addon fixture</h1></body></html>'
      const served = await serveApp(app, ORIGIN, MANIFEST, 'fs', {
        '/index.html': new TextEncoder().encode(html),
        '/app.js': await bundleForApp(fileURLToPath(new URL('./native-addon-entry.ts', import.meta.url))),
        '/addon-child.js': await bundleForApp(fileURLToPath(new URL('./native-addon-fork-entry.ts', import.meta.url)), 'esm'),
        '/native/answer.wasm': napiAddon(),
        '/native/big.wasm32-wasi.wasm': napiAddon(OVER_SYNC_LIMIT)
      })
      check('the fixture is granted and registered for serving', served.granted && served.registered, JSON.stringify(served))

      const view = await navigateToFixture(app, `${ORIGIN}/`, 'native addon fixture')
      const results = await evaluateRetrying(view, async () => await (globalThis as unknown as { nativeAddonE2e: { run: () => Promise<NativeAddonResults> } }).nativeAddonE2e.run(), 60_000)
      const detail = JSON.stringify(results)

      check('the page ran every case without throwing', results.error === undefined, detail)
      check('createRequire loaded a small addon synchronously, its Node-API exports intact', results.small?.answer === 42 && results.small.greet === 'hello from wasm', detail)
      check('process.dlopen loaded it too', results.dlopen === 42, detail)
      check('an addon over the synchronous-compile limit refuses on the page, naming preloadAddon', results.bigSync === 'ERR_DLOPEN_FAILED names preloadAddon', detail)
      check('after preloadAddon, the same synchronous load returns it', results.bigPreloaded === 42, detail)
      check('an addon with no WebAssembly build is ERR_DLOPEN_FAILED', results.missing?.startsWith('ERR_DLOPEN_FAILED') === true, detail)
      check('a forked child loaded the large addon synchronously and sent its exports back', JSON.stringify(results.forked) === JSON.stringify({ answer: 42, greet: 'hello from wasm' }), detail)
    })

    await runPhase('native addon files', async (check) => {
      const html = '<!doctype html><html><head><title>native addon files fixture</title><script src="/app.js"></script></head><body><h1>native addon files fixture</h1></body></html>'
      const served = await serveApp(app, ISOLATED_ORIGIN, ISOLATED_MANIFEST, 'fs', {
        '/index.html': new TextEncoder().encode(html),
        '/app.js': await bundleForApp(fileURLToPath(new URL('./native-addon-files-entry.ts', import.meta.url))),
        '/files-child.js': await bundleForApp(fileURLToPath(new URL('./native-addon-files-child.ts', import.meta.url)), 'esm'),
        '/native/files.wasm': fileAddon()
      })
      check('the isolated fixture is granted and registered for serving', served.granted && served.registered, JSON.stringify(served))

      const view = await navigateToFixture(app, `${ISOLATED_ORIGIN}/`, 'native addon files fixture')
      const results = await evaluateRetrying(view, async () => await (globalThis as unknown as { nativeAddonFilesE2e: { run: () => Promise<NativeAddonFileResults> } }).nativeAddonFilesE2e.run(), 60_000)
      const detail = JSON.stringify(results)

      check('the page ran without throwing', results.error === undefined, detail)
      check('the fixture is cross-origin isolated', results.isolated === true, detail)
      check('on the page\'s main thread, the addon\'s file call refuses with NOSYS', results.pageOpenErrno === NOSYS, detail)
      check('in a forked child, the addon read the file the page wrote', JSON.stringify(results.forked) === JSON.stringify({ openErrno: 0, content: 'written by the page', readFileSync: 'written by the page' }), detail)
      check('and the file the addon wrote is there for the page', results.written === 'from addon', detail)
    })
  } finally {
    await closeElectronApp(app)
  }
}, 180_000)
