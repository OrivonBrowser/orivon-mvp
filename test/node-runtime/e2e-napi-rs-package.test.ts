// A napi-rs package's published WebAssembly build, run unchanged in a real
// app tab through the package's own browser loader: the build is threaded
// (a shared memory, wasi-threads, napi-rs's async work on a pool of module
// Workers), and nothing of Orivon's addon loader is involved. What Orivon
// supplies is the serving a cross-origin isolated app gets: the headers that
// give it SharedArrayBuffer, and a CSP admitting WebAssembly and same-origin
// module Workers. The package comes from npm, so this runs only when
// ORIVON_NAPI_RS_PACKAGE_DIR names a directory it was installed in:
//
//   npm install --prefix <dir> @node-rs/argon2-wasm32-wasi@2.2.1
//   node scripts/build-e2e.mjs
//   ORIVON_NAPI_RS_PACKAGE_DIR=<dir> npx vitest run --config test/vitest.e2e.config.ts test/node-runtime/e2e-napi-rs-package.test.ts
//
// Last run with @node-rs/argon2-wasm32-wasi 2.2.1: passes.
import { afterAll, expect, it } from 'vitest'
import esbuild from 'esbuild'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER } from '../support/smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase, waitForPageGlobal } from '../support/e2e-helpers.js'
import { serveApp } from './pinned-app.js'
import type { Manifest } from '../../src/contracts/index.js'

const PACKAGE_DIR = process.env.ORIVON_NAPI_RS_PACKAGE_DIR
const PACKAGE = '@node-rs/argon2-wasm32-wasi'
const ORIGIN = 'https://napi-rs-package-e2e.orivon.test'
// Where the loader looks for its Worker: `new URL('<package>/wasi-worker-browser.mjs', import.meta.url)`, a path Vite rewrites and esbuild leaves as it is.
const WORKER = `${PACKAGE}/wasi-worker-browser.mjs`
const WASM = 'argon2.wasm32-wasi.wasm'

const MANIFEST: Manifest = {
  orivonApiVersion: 0,
  id: 'app.orivon.napi-rs-package-e2e',
  name: 'napi-rs package e2e fixture',
  version: '1.0.0',
  entry: 'index.html',
  assets: ['app.js', WASM, WORKER],
  capabilities: { fs: { quotaBytes: 1_048_576 } },
  crossOriginIsolated: true
}

const ENTRY = `
import { hash, hashSync, verify } from '${PACKAGE}'
globalThis.napiRsPackageE2e = {
  run: async () => {
    try {
      const hashed = await hash('correct horse')
      return { isolated: globalThis.crossOriginIsolated, prefix: hashed.slice(0, 10), verified: await verify(hashed, 'correct horse'), wrong: await verify(hashed, 'battery staple'), sync: hashSync('x').slice(0, 10) }
    } catch (error) {
      return { error: String(error?.stack ?? error) }
    }
  }
}
`

interface Results { isolated?: boolean, prefix?: string, verified?: boolean, wrong?: boolean, sync?: string, error?: string }

/** The page script and the loader's Worker, bundled from the installed package as a port's bundler would bundle them. */
async function bundle (dir: string): Promise<{ app: Uint8Array, worker: Uint8Array }> {
  const options = { bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false, absWorkingDir: dir, logLevel: 'silent' } as const
  const app = await esbuild.build({ ...options, stdin: { contents: ENTRY, resolveDir: dir, loader: 'js' } })
  const worker = await esbuild.build({ ...options, entryPoints: [join(dir, 'node_modules', WORKER)] })
  const [appOut] = app.outputFiles
  const [workerOut] = worker.outputFiles
  if (appOut === undefined || workerOut === undefined) throw new Error('esbuild produced no output')
  return { app: appOut.contents, worker: workerOut.contents }
}

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it.skipIf(PACKAGE_DIR === undefined)('runs a published threaded napi-rs build through its own browser loader in a cross-origin isolated app', async () => {
  const dir = PACKAGE_DIR as string
  const { app: script, worker } = await bundle(dir)
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    await runPhase('napi-rs package', async (check) => {
      const html = '<!doctype html><html><head><title>napi-rs package fixture</title><script type="module" src="/app.js"></script></head><body><h1>napi-rs package fixture</h1></body></html>'
      const served = await serveApp(app, ORIGIN, MANIFEST, 'fs', {
        '/index.html': new TextEncoder().encode(html),
        '/app.js': script,
        [`/${WASM}`]: readFileSync(join(dir, 'node_modules', PACKAGE, WASM)),
        [`/${WORKER}`]: worker
      })
      check('the fixture is granted and registered for serving', served.granted && served.registered, JSON.stringify(served))

      const view = await navigateToFixture(app, `${ORIGIN}/`, 'napi-rs package fixture')
      await waitForPageGlobal(view, 'napiRsPackageE2e')
      const results = await evaluateRetrying(view, async () => await (globalThis as unknown as { napiRsPackageE2e: { run: () => Promise<Results> } }).napiRsPackageE2e.run(), 60_000)
      const detail = JSON.stringify(results)

      check('the page ran without throwing', results.error === undefined, detail)
      check('the app is cross-origin isolated', results.isolated === true, detail)
      check('hash, napi-rs async work on the thread pool, returned an argon2id hash', results.prefix === '$argon2id$', detail)
      check('verify accepts the password and refuses another', results.verified === true && results.wrong === false, detail)
      check('hashSync ran on the page\'s own thread', results.sync === '$argon2id$', detail)
    })
  } finally {
    await closeElectronApp(app)
  }
}, 180_000)
