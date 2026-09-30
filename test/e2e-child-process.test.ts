// child_process end to end in a real app tab. The page's `spawn` runs a WASI
// program from the pinned bundle in a Worker started from the shim's blob
// runtime, under the served CSP; `fork` imports the app's own /child.js into
// another, whose `fs` calls reach the real broker through the page; a native
// program in the bundle is refused by name and a missing one is ENOENT;
// `kill()` ends a running child; a WASI 0.2 component runs from the jco
// output beside it, its glue imported by the Worker under the served CSP; and
// a `worker_threads` thread over /thread.js gets its workerData, round-trips
// a message and a MessageChannel port it was passed, reaches the broker
// through its own `fs.promises`, shares a SharedArrayBuffer in workerData
// with the page that started it, and ends when `terminate()` is called. A
// second app, granted one TCP address, spawns a component whose socket
// reaches a real echo server through the broker; a third spawns a component
// that listens, and its page connects to it, as an app reaches its daemon.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && npx vitest run --config test/vitest.e2e.config.ts test/e2e-child-process.test.ts
import { afterAll, expect, it } from 'vitest'
import type { ConsoleMessage, Worker } from 'playwright'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { evaluateRetrying, HERMETIC_RESOLVER } from './smoke-helpers.mjs'
import { closeElectronApp, navigateToFixture, runPhase, waitForPageGlobal } from './e2e-helpers.js'
import { bundleForApp, serveApp } from './pinned-app.js'
import type { ChildProcessResults } from './child-process-entry.js'
import type { ComponentSocketResults } from './child-process-socket-entry.js'
import type { ComponentListenerResults } from './child-process-listener-entry.js'
import { echoProgram } from '../src/shim/wasi/tests/support/programs.js'
import { LISTENER_TARGET, SOCKET_TARGET, listenerFixture, socketFixture, tourFixture } from '../src/shim/wasi-p2/tests/support/component-fixture.js'
import type { Manifest } from '../src/contracts/index.js'

const ORIGIN = 'https://child-process-e2e.orivon.test'
const ELF = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])
const COMPONENT_HEADER = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00])
const tour = tourFixture()
/** The fixture component as a port ships it: its header at /bin/tour.wasm, jco's output under /bin/tour.p2/. */
const COMPONENT_FILES: Record<string, Uint8Array> = {
  '/bin/tour.wasm': COMPONENT_HEADER,
  '/bin/tour.p2/tour.js': new TextEncoder().encode(tour.glue),
  ...Object.fromEntries([...tour.cores].map(([name, bytes]) => [`/bin/tour.p2/${name}`, bytes]))
}

const MANIFEST: Manifest = {
  orivonApiVersion: 0,
  id: 'app.orivon.child-process-e2e',
  name: 'child_process e2e fixture',
  version: '1.0.0',
  entry: 'index.html',
  assets: ['app.js', 'child.js', 'thread.js', 'bin/echo.wasm', 'bin/native', ...Object.keys(COMPONENT_FILES).map((path) => path.slice(1))],
  // A worker_threads thread's own e2e case needs SharedArrayBuffer, which only a cross-origin
  // isolated app gets.
  crossOriginIsolated: true,
  capabilities: { fs: { quotaBytes: 1_048_576 } }
}

const SOCKET_ORIGIN = 'https://component-socket-e2e.orivon.test'
const socket = socketFixture()
const SOCKET_FILES: Record<string, Uint8Array> = {
  '/bin/socket.wasm': COMPONENT_HEADER,
  '/bin/socket.p2/socket.js': new TextEncoder().encode(socket.glue),
  ...Object.fromEntries([...socket.cores].map(([name, bytes]) => [`/bin/socket.p2/${name}`, bytes]))
}
const SOCKET_ADDRESS = `${SOCKET_TARGET.address.join('.')}:${SOCKET_TARGET.port}`
/** Granted to the second socket fixture instead of SOCKET_ADDRESS: nothing listens there, and it is never reached. */
const OTHER_ADDRESS = `${SOCKET_TARGET.address.join('.')}:${SOCKET_TARGET.port + 10}`
const REFUSED_ORIGIN = 'https://component-socket-refused-e2e.orivon.test'
const SOCKET_MANIFEST: Manifest = {
  orivonApiVersion: 0,
  id: 'app.orivon.component-socket-e2e',
  name: 'component socket e2e fixture',
  version: '1.0.0',
  entry: 'index.html',
  assets: ['app.js', ...Object.keys(SOCKET_FILES).map((path) => path.slice(1))],
  capabilities: { net: { tcp: { connect: [SOCKET_ADDRESS] } } }
}

const LISTENER_ORIGIN = 'https://component-listener-e2e.orivon.test'
const listener = listenerFixture()
const LISTENER_FILES: Record<string, Uint8Array> = {
  '/bin/listener.wasm': COMPONENT_HEADER,
  '/bin/listener.p2/listener.js': new TextEncoder().encode(listener.glue),
  ...Object.fromEntries([...listener.cores].map(([name, bytes]) => [`/bin/listener.p2/${name}`, bytes]))
}
const LISTENER_ADDRESS = `${LISTENER_TARGET.address.join('.')}:${LISTENER_TARGET.port}`
const LISTENER_MANIFEST: Manifest = {
  orivonApiVersion: 0,
  id: 'app.orivon.component-listener-e2e',
  name: 'component listener e2e fixture',
  version: '1.0.0',
  entry: 'index.html',
  assets: ['app.js', ...Object.keys(LISTENER_FILES).map((path) => path.slice(1))],
  // The broker authorises every listen by the network grant today (ADR-0034), whatever scope is asked.
  capabilities: { net: { tcp: { connect: [LISTENER_ADDRESS], listen: { network: [String(LISTENER_TARGET.port)] } } } }
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
        '/thread.js': await bundleForApp(fileURLToPath(new URL('./child-process-thread-entry.ts', import.meta.url)), 'esm'),
        '/bin/echo.wasm': echoProgram(),
        '/bin/native': ELF,
        ...COMPONENT_FILES
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
      check('a WASI 0.2 component ran from its jco output: spawn, exit 1 for its code 3, close', JSON.stringify(results.component?.events) === JSON.stringify(['spawn', 'exit 1 null']), detail)
      check('the component echoed stdin to stdout and wrote stderr', results.component?.stdout === 'from a component\n' && results.component.stderr === 'done\n', detail)
      check('the component\'s file write reached the app\'s files through the broker', results.component?.fileText === 'written by a component\n', detail)
      check('a worker_threads thread round-tripped a message, and a MessageChannel port it was passed reached it', results.thread?.portReply === 'pong via port' && JSON.stringify(results.thread.workerReply) === JSON.stringify({ echoedPing: 'hi from the page', wroteText: 'written by a thread', sawFromPage: 111 }), detail)
      check('the thread\'s fs.promises write reached the app\'s files through the broker', results.thread?.fileText === 'written by a thread', detail)
      check('terminate() resolved with the thread\'s exit code', results.thread?.terminatedWith !== undefined, detail)
      check('a SharedArrayBuffer in workerData reached the thread, and both sides saw the same memory: never routed through the app\'s child host', results.thread?.sawFromPage === 111 && results.thread.afterThreadWrote === 222, detail)
    })

    await runPhase('a component\'s socket', async (check) => {
      const echo = createServer((connection) => { connection.pipe(connection) })
      await new Promise<void>((resolve) => { echo.listen(SOCKET_TARGET.port, SOCKET_TARGET.address.join('.'), resolve) })
      try {
        const html = '<!doctype html><html><head><title>component socket fixture</title><script src="/app.js"></script></head><body><h1>component socket fixture</h1></body></html>'
        const served = await serveApp(app, SOCKET_ORIGIN, SOCKET_MANIFEST, 'tcp.connect', {
          '/index.html': new TextEncoder().encode(html),
          '/app.js': await bundleForApp(fileURLToPath(new URL('./child-process-socket-entry.ts', import.meta.url))),
          ...SOCKET_FILES
        }, [SOCKET_ADDRESS])
        check('the socket fixture is granted tcp.connect to one address and registered', served.granted && served.registered, JSON.stringify(served))
        const view = await navigateToFixture(app, `${SOCKET_ORIGIN}/`, 'component socket fixture')
        await waitForPageGlobal(view, 'componentSocketE2e')
        const results = await evaluateRetrying(view, async () => await (globalThis as unknown as { componentSocketE2e: { run: () => Promise<ComponentSocketResults> } }).componentSocketE2e.run(), 30_000)
        const detail = JSON.stringify(results)
        check('the page ran the component without throwing', results.error === undefined, detail)
        check('the component connected through the broker, and its message came back from the echo server to its stdout', results.stdout === SOCKET_TARGET.message, detail)
        check('the component exited 0', JSON.stringify(results.events) === JSON.stringify(['spawn', 'exit 0 null']), detail)

        const refused = await serveApp(app, REFUSED_ORIGIN, { ...SOCKET_MANIFEST, id: 'app.orivon.component-socket-refused-e2e', capabilities: { net: { tcp: { connect: [OTHER_ADDRESS] } } } }, 'tcp.connect', {
          '/index.html': new TextEncoder().encode(html),
          '/app.js': await bundleForApp(fileURLToPath(new URL('./child-process-socket-entry.ts', import.meta.url))),
          ...SOCKET_FILES
        }, [OTHER_ADDRESS])
        check('a second fixture is granted tcp.connect to another address only', refused.granted && refused.registered, JSON.stringify(refused))
        const refusedView = await navigateToFixture(app, `${REFUSED_ORIGIN}/`, 'component socket fixture')
        await waitForPageGlobal(refusedView, 'componentSocketE2e')
        const outcome = await evaluateRetrying(refusedView, async () => await (globalThis as unknown as { componentSocketE2e: { run: () => Promise<ComponentSocketResults> } }).componentSocketE2e.run(), 30_000)
        check(`the same component, spawned by an app not granted ${SOCKET_ADDRESS}, has its connect refused by the broker: no reply, exit 1, while the echo server still listens`,
          outcome.stdout === '' && JSON.stringify(outcome.events) === JSON.stringify(['spawn', 'exit 1 null']), JSON.stringify(outcome))
      } finally {
        await new Promise((resolve) => { echo.close(resolve) })
      }
    })

    await runPhase('a component that listens', async (check) => {
      const html = '<!doctype html><html><head><title>component listener fixture</title><script src="/app.js"></script></head><body><h1>component listener fixture</h1></body></html>'
      const served = await serveApp(app, LISTENER_ORIGIN, LISTENER_MANIFEST, 'tcp.listen.network', {
        '/index.html': new TextEncoder().encode(html),
        '/app.js': await bundleForApp(fileURLToPath(new URL('./child-process-listener-entry.ts', import.meta.url))),
        ...LISTENER_FILES
      }, [String(LISTENER_TARGET.port)], [{ capability: 'tcp.connect', patterns: [LISTENER_ADDRESS] }])
      check('the listener fixture is granted tcp.listen.network and tcp.connect for one port, and registered', served.granted && served.registered, JSON.stringify(served))
      const view = await navigateToFixture(app, `${LISTENER_ORIGIN}/`, 'component listener fixture')
      await waitForPageGlobal(view, 'componentListenerE2e')
      const port = LISTENER_TARGET.port
      const results = await evaluateRetrying(view, async () => await (globalThis as unknown as { componentListenerE2e: { run: (port: number) => Promise<ComponentListenerResults> } }).componentListenerE2e.run(8912), 30_000).catch(async (error: unknown) => {
        const progress = await view.evaluate(() => (globalThis as unknown as { componentListenerProgress?: string[] }).componentListenerProgress)
        return { error: `${String(error)}; progress: ${JSON.stringify(progress)}` }
      })
      const detail = JSON.stringify(results)
      check('the page ran the listener without throwing', results.error === undefined, detail)
      check('the component listened through the broker and said so', results.stdout?.startsWith(LISTENER_TARGET.ready) === true, detail)
      check(`the page connected to the component on ${port} and its message came back`, results.echoed === 'hello from the page\n', detail)
      check('the component printed what it received, and exited 0', results.stdout === `${LISTENER_TARGET.ready}hello from the page\n` && JSON.stringify(results.events) === JSON.stringify(['spawn', 'exit 0 null']), detail)
    })
  } finally {
    await closeElectronApp(app)
  }
}, 180_000)
