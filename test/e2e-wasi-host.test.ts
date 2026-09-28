// The WASI host end to end: a pinned app's page runs a WebAssembly program
// through the `wasi` module target, and the program's file calls reach the
// real broker over the real IPC pipe, suspending the program through JSPI
// on the page's main thread. What only a real launch can show: JSPI in this
// Chromium's renderer, the `.wasm` fetched and compiled under the served
// CSP, and the broker's confinement sitting under the host's own check.
//
// The program writes greeting.txt, prints `done`, then tries to create
// ../escape and exits with that call's errno: 76, NOTCAPABLE, when every
// earlier call succeeded. The page then reads greeting.txt back through
// orivon.fs directly, so the bytes are proven to be where the broker keeps
// the app's files.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && npx vitest run --config test/vitest.e2e.config.ts test/e2e-wasi-host.test.ts
import { afterAll, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER } from './smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase, waitForPageGlobal } from './e2e-helpers.js'
import { shimEsbuildPlugin } from '../src/shim/tests/support/shim-esbuild-plugin.js'
import type { WasiRunResult } from './wasi-host-entry.js'
import { bundleTree } from '../src/broker/policy/bundle-hash.js'
import type { BundleEntry } from '../src/broker/policy/bundle-hash.js'
import { fromBundleTree } from '../src/broker/policy/pin.js'
import { nodeLoaderStorage } from '../src/loader/cache/node-storage.js'
import { op, wasiModule } from '../src/shim/wasi/tests/support/wasm-module.js'
import type { DevGrantRequest } from '../src/main/dev/dev-grant.js'
import type { Grant, Manifest } from '../src/contracts/index.js'

const ORIGIN = 'https://wasi-host-e2e.orivon.test'
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const GREETING = 'hello from wasi'
const READ_WRITE = (1n << 1n) | (1n << 6n)
const CREAT_TRUNC = 1 | 8

const MANIFEST: Manifest = {
  orivonApiVersion: 0,
  id: 'app.orivon.wasi-host-e2e',
  name: 'WASI host e2e fixture',
  version: '1.0.0',
  entry: 'index.html',
  assets: ['wasi-app.js', 'program.wasm'],
  capabilities: { fs: { quotaBytes: 1_048_576 } }
}

/** path_open(3, name) with CREAT|TRUNC, leaving the new fd at address 16 and the errno on the stack. */
function openAt (name: { offset: number, length: number }, call: (import_: string) => number[]): number[][] {
  return [
    op.i32(3), op.i32(0), op.i32(name.offset), op.i32(name.length), op.i32(CREAT_TRUNC),
    op.i64(READ_WRITE), op.i64(0n), op.i32(0), op.i32(16), call('path_open')
  ]
}

function program (): Uint8Array<ArrayBuffer> {
  const file = { offset: 200, text: 'greeting.txt' }
  const escape = { offset: 240, text: '../escape' }
  const greeting = { offset: 300, text: GREETING }
  const done = { offset: 400, text: 'done\n' }
  const accumulate = [op.localGet(0), op.i32Add, op.localSet(0)]
  return wasiModule({
    imports: ['path_open', 'fd_write', 'fd_close', 'proc_exit'],
    data: [file, escape, greeting, done],
    locals: 1,
    body: (call) => [
      ...openAt({ offset: file.offset, length: file.text.length }, call), op.localSet(0),
      op.store(0, greeting.offset), op.store(4, greeting.text.length),
      op.load(16), op.i32(0), op.i32(1), op.i32(20), call('fd_write'), ...accumulate,
      op.load(16), call('fd_close'), ...accumulate,
      op.store(0, done.offset), op.store(4, done.text.length),
      op.i32(1), op.i32(0), op.i32(1), op.i32(20), call('fd_write'), ...accumulate,
      ...openAt({ offset: escape.offset, length: escape.text.length }, call), op.localGet(0), op.i32Add,
      call('proc_exit')
    ]
  })
}

async function appScript (): Promise<Uint8Array> {
  const built = await esbuild.build({
    entryPoints: [fileURLToPath(new URL('./wasi-host-entry.ts', import.meta.url))],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    write: false,
    absWorkingDir: REPO_ROOT,
    plugins: [shimEsbuildPlugin()],
    logLevel: 'silent'
  })
  const [output] = built.outputFiles
  if (output === undefined) throw new Error('esbuild produced no output for the WASI entry')
  return output.contents
}

async function pinFixture (userDataDir: string): Promise<void> {
  const storage = nodeLoaderStorage(userDataDir)
  const html = '<!doctype html><html><head><title>WASI host fixture</title><script src="/wasi-app.js"></script></head><body><h1>WASI host fixture</h1></body></html>'
  const entries: BundleEntry[] = [
    { path: '/.well-known/orivon.json', content: new TextEncoder().encode(JSON.stringify(MANIFEST)) },
    { path: '/index.html', content: new TextEncoder().encode(html) },
    { path: '/wasi-app.js', content: await appScript() },
    { path: '/program.wasm', content: program() }
  ]
  const tree = await bundleTree(entries)
  for (const entry of entries) await storage.writeAsset(ORIGIN, entry.path, entry.content)
  await storage.writePin(ORIGIN, fromBundleTree(ORIGIN, tree.root, tree.assets, '1.0.0', 0))
}

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('a pinned app runs a WASI program whose file calls reach the real broker through JSPI, and whose escape is refused', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    await runPhase('WASI host', async (check) => {
      const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
      await pinFixture(userDataDir)
      const granted = await app.evaluate(async (_electron, request: DevGrantRequest) => {
        const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
        if (typeof hook !== 'function') return false
        await hook(request)
        return true
      }, { origin: ORIGIN, manifest: MANIFEST, capability: 'fs', patterns: [] } satisfies DevGrantRequest)
      check('the developer-only grant hook granted fs', granted)
      const registered = await app.evaluate(async (_electron, target: string) => {
        const hook = (globalThis as unknown as { __orivonDevRegisterServing?: (origin: string) => Promise<void> }).__orivonDevRegisterServing
        if (typeof hook !== 'function') return false
        await hook(target)
        return true
      }, ORIGIN)
      check('the dev-only serve-registration hook registered the fixture', registered)

      const view = await navigateToFixture(app, `${ORIGIN}/`, 'WASI host fixture')
      await waitForPageGlobal(view, 'wasiE2e')
      const outcome = await evaluateRetrying(view, async (): Promise<{ run: WasiRunResult, jspi: boolean, readBack: string }> => {
        const jspi = typeof (WebAssembly as unknown as { Suspending?: unknown }).Suspending === 'function'
        const run = await (globalThis as unknown as { wasiE2e: { run: () => Promise<WasiRunResult> } }).wasiE2e.run()
        let readBack: string
        try {
          const orivon = (window as unknown as { orivon: { fs: { readFile: (path: string) => Promise<Uint8Array> } } }).orivon
          readBack = new TextDecoder().decode(await orivon.fs.readFile('greeting.txt'))
        } catch (error) {
          readBack = `threw ${String(error)}`
        }
        return { run, jspi, readBack }
      }, 40_000)

      check('the app tab\'s Chromium has JSPI', outcome.jspi, JSON.stringify(outcome))
      check('the program ran to proc_exit without the host throwing', outcome.run.error === undefined, JSON.stringify(outcome))
      check('every file call succeeded and the escape attempt came back NOTCAPABLE (exit code 76)', outcome.run.exitCode === 76, JSON.stringify(outcome))
      check('fd 1 reached the page console, one entry per line', outcome.run.stdout.includes('done'), JSON.stringify(outcome))
      check('the bytes the program wrote are in the app\'s own files, read back through orivon.fs', outcome.readBack === GREETING, JSON.stringify(outcome))
    })
  } finally {
    await closeElectronApp(app)
  }
}, 180_000)
