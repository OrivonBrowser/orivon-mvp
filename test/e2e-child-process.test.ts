// child_process end to end in a real app tab. The page's `spawn` runs a WASI
// program from the pinned bundle in a Worker started from the shim's blob
// runtime, under the served CSP; `fork` imports the app's own /child.js into
// another, whose `fs` calls reach the real broker through the page; a native
// program in the bundle is refused by name and a missing one is ENOENT; and
// `kill()` ends a running child.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && npx vitest run --config test/vitest.e2e.config.ts test/e2e-child-process.test.ts
import { afterAll, expect, it } from 'vitest'
import type { ConsoleMessage, Worker } from 'playwright'
import { fileURLToPath } from 'node:url'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER } from './smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase, waitForPageGlobal } from './e2e-helpers.js'
import { bundleForApp, serveApp } from './pinned-app.js'
import type { ChildProcessResults } from './child-process-entry.js'
import { echoProgram } from '../src/shim/wasi/tests/support/programs.js'
import type { Manifest } from '../src/contracts/index.js'

const ORIGIN = 'https://child-process-e2e.orivon.test'
const ELF = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])

const MANIFEST: Manifest = {
  orivonApiVersion: 0,
  id: 'app.orivon.child-process-e2e',
  name: 'child_process e2e fixture',
  version: '1.0.0',
  entry: 'index.html',
  assets: ['app.js', 'child.js', 'bin/echo.wasm', 'bin/native'],
  capabilities: { fs: { quotaBytes: 1_048_576 } }
}

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('spawns a WASI program and forks an app module in Workers, refuses a native program, and kills a running child', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    await runPhase('child_process', async (check) => {
      const html = '<!doctype html><html><head><title>child_process fixture</title><script src="/app.js"></script></head><body><h1>child_process fixture</h1></body></html>'
      const served = await serveApp(app, ORIGIN, MANIFEST, 'fs', {
        '/index.html': new TextEncoder().encode(html),
        '/app.js': await bundleForApp(fileURLToPath(new URL('./child-process-entry.ts', import.meta.url))),
        '/child.js': await bundleForApp(fileURLToPath(new URL('./child-process-fork-entry.ts', import.meta.url)), 'esm'),
        '/bin/echo.wasm': echoProgram(),
        '/bin/native': ELF
      })
      check('the fixture is granted fs and registered for serving', served.granted && served.registered, JSON.stringify(served))

      const view = await navigateToFixture(app, `${ORIGIN}/`, 'child_process fixture')
      const consoleLines: string[] = []
      view.on('console', (message: ConsoleMessage) => consoleLines.push(`page: ${message.text()}`))
      view.on('worker', (worker: Worker) => { worker.on('console', (message: ConsoleMessage) => consoleLines.push(`worker: ${message.text()}`)) })
      view.on('pageerror', (error: Error) => consoleLines.push(`pageerror: ${error.message}`))
      await waitForPageGlobal(view, 'childProcessE2e')
      const results = await evaluateRetrying(view, async () => await (globalThis as unknown as { childProcessE2e: { run: () => Promise<ChildProcessResults> } }).childProcessE2e.run(), 30_000).catch(async (error: unknown) => {
        const progress = await view.evaluate(() => (globalThis as unknown as { childProcessProgress?: string[] }).childProcessProgress)
        throw new Error(`${String(error)}\nprogress: ${JSON.stringify(progress)}\nconsole: ${consoleLines.join('\n')}`)
      })
      const detail = JSON.stringify(results)

      check('the page ran every case without throwing', results.error === undefined, detail)
      check('spawn ran the WASI program in a Worker: spawn, exit 0, close', JSON.stringify(results.echo?.events) === JSON.stringify(['spawn', 'exit 0 null']), detail)
      check('the program echoed the page\'s stdin to its stdout', results.echo?.stdout === 'ping from the page', detail)
      check('a native program in the bundle is refused by name, as ENOEXEC', results.native?.code === 'ENOEXEC' && results.native.reason === 'excluded', detail)
      check('a missing program is ENOENT, as Node reports one', results.missing?.code === 'ENOENT', detail)
      check('the forked module answered over IPC with its argv', JSON.stringify(results.forked?.reply) === JSON.stringify({ argv: ['/child.js', 'argument'], wrote: true }), detail)
      check('the forked module\'s fs write reached the app\'s files through the broker', results.forked?.fileText === 'written by a forked child', detail)
      check('the forked module\'s process.exit code reached the page', results.forked?.exitCode === 5, detail)
      check('kill() ended a running child with SIGTERM', JSON.stringify(results.killed?.events) === JSON.stringify(['spawn', 'exit null SIGTERM']), detail)
    })
  } finally {
    await closeElectronApp(app)
  }
}, 180_000)
