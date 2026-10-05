// ADR-0046's own end-to-end proof: a child a page starts outlives that page
// while another page of the same app is open, and ends only with the app's
// last page. Tab A forks a heartbeat that writes an incrementing tick count
// through fs every 200ms; tab B, a second tab of the SAME app (a different
// served path, so the two are distinguishable by URL), reads it. Closing tab
// A leaves the heartbeat running, observed from tab B; closing tab B too
// stops it. A separate, single-tab phase proves a reload of an app's only
// page ends its children the same way closing it would. A third phase proves
// the same lifetime for a SPAWNED program, routed through the host only as of
// this file's own change: a component that listens is spawned from tab A,
// which then closes; tab B -- which never started it -- still reaches it
// over its own port and gets its echo back; tab B's own page then ending
// (a reload, this file's own established stand-in for a close, per the
// second phase) ends the listener, and its port stops answering.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && npx vitest run --config test/vitest.e2e.config.ts test/node-runtime/e2e-child-host.test.ts
import { afterAll, expect, it } from 'vitest'
import type { ConsoleMessage, Worker } from 'playwright'
import { fileURLToPath } from 'node:url'
import { connect as netConnect } from 'node:net'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { evaluateRetrying, findChrome, findViewShowing, HERMETIC_RESOLVER, tabIds, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import {
  clickAddressBarRetrying, closeElectronApp, navigateToFixture, runPhase, waitForAddressBarStable, waitForPageGlobal
} from '../support/e2e-helpers.js'
import { bundleForApp, serveApp } from './pinned-app.js'
import type { ChildHostE2eResults } from './child-host-entry.js'
import type { ChildHostSpawnEchoResult, ChildHostSpawnStartResult } from './child-host-spawn-entry.js'
import { LISTENER_TARGET, listenerFixture } from '../../src/shim/wasi-p2/tests/support/component-fixture.js'
import type { Manifest } from '../../src/contracts/index.js'

const ORIGIN = 'https://child-host-e2e.orivon.test'
const TITLE = 'child host fixture'
const HTML = `<!doctype html><html><head><title>${TITLE}</title><script src="/app.js"></script></head><body><h1>${TITLE}</h1></body></html>`

const MANIFEST: Manifest = {
  orivonApiVersion: 0,
  id: 'app.orivon.child-host-e2e',
  name: 'child host e2e fixture',
  version: '1.0.0',
  entry: 'index.html',
  assets: ['app.js', 'heartbeat.js', 'second.html'],
  capabilities: { fs: { quotaBytes: 1_048_576 } }
}

const SPAWN_ORIGIN = 'https://child-host-spawn-e2e.orivon.test'
const SPAWN_TITLE = 'child host spawn fixture'
const SPAWN_HTML = `<!doctype html><html><head><title>${SPAWN_TITLE}</title><script src="/app.js"></script></head><body><h1>${SPAWN_TITLE}</h1></body></html>`
const COMPONENT_HEADER = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00])
const listener = listenerFixture()
const LISTENER_FILES: Record<string, Uint8Array> = {
  '/bin/listener.wasm': COMPONENT_HEADER,
  '/bin/listener.p2/listener.js': new TextEncoder().encode(listener.glue),
  ...Object.fromEntries([...listener.cores].map(([name, bytes]) => [`/bin/listener.p2/${name}`, bytes]))
}
const LISTENER_ADDRESS = `${LISTENER_TARGET.address.join('.')}:${LISTENER_TARGET.port}`
const SPAWN_MANIFEST: Manifest = {
  orivonApiVersion: 0,
  id: 'app.orivon.child-host-spawn-e2e',
  name: 'child host spawn e2e fixture',
  version: '1.0.0',
  entry: 'index.html',
  assets: ['app.js', 'second.html', ...Object.keys(LISTENER_FILES).map((path) => path.slice(1))],
  capabilities: { net: { tcp: { connect: [LISTENER_ADDRESS], listen: { network: [String(LISTENER_TARGET.port)] } } } }
}

/** Whether a plain, external `net.connect` to the listener's own port succeeds -- used only
 * AFTER every tab of the spawn fixture is gone, to confirm nothing answers there any more. */
async function portAnswers (port: number, timeoutMs = 2000): Promise<boolean> {
  return await new Promise((resolve) => {
    const probe = netConnect(port, '127.0.0.1')
    const timer = setTimeout(() => { probe.destroy(); resolve(false) }, timeoutMs)
    probe.once('connect', () => { clearTimeout(timer); probe.destroy(); resolve(true) })
    probe.once('error', () => { clearTimeout(timer); resolve(false) })
  })
}

/** `readCount()` on `view`, retried the way every page-global read here is: the fixture's own
 * `evaluateRetrying` budget already covers a page mid-navigation. */
async function heartbeatCount (view: ReturnType<typeof findChrome>): Promise<number> {
  return await evaluateRetrying(view, async () => await (globalThis as unknown as { childHostE2e: { readCount: () => Promise<number> } }).childHostE2e.readCount())
}

async function waitForCountAbove (view: ReturnType<typeof findChrome>, floor: number, timeoutMs = 8_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const count = await heartbeatCount(view)
    if (count > floor) return count
    if (Date.now() >= deadline) throw new Error(`heartbeat count never rose above ${floor} within ${timeoutMs}ms (last saw ${count})`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** True if the count read twice, `settleMs` apart, never moved -- the heartbeat has stopped. */
async function heartbeatStopped (view: ReturnType<typeof findChrome>, settleMs = 700): Promise<boolean> {
  const first = await heartbeatCount(view)
  await new Promise((resolve) => setTimeout(resolve, settleMs))
  const second = await heartbeatCount(view)
  return first === second
}

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:forked-child-ends-with-last-page] a child outlives the page that started it while another page of the app is open, and ends with the app\'s last page', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    const appJs = await bundleForApp(fileURLToPath(new URL('./child-host-entry.ts', import.meta.url)))
    const heartbeatJs = await bundleForApp(fileURLToPath(new URL('./child-host-heartbeat-entry.ts', import.meta.url)), 'esm')

    await runPhase('a second tab keeps the heartbeat alive, closing both ends it', async (check) => {
      const served = await serveApp(app, ORIGIN, MANIFEST, 'fs', {
        '/index.html': new TextEncoder().encode(HTML),
        '/second.html': new TextEncoder().encode(HTML),
        '/app.js': appJs,
        '/heartbeat.js': heartbeatJs
      })
      check('the fixture is granted fs and registered for serving', served.granted && served.registered, JSON.stringify(served))

      const viewA = await navigateToFixture(app, `${ORIGIN}/`, TITLE)
      const consoleLines: string[] = []
      viewA.on('console', (m: ConsoleMessage) => consoleLines.push(`page: ${m.text()}`))
      viewA.on('pageerror', (e: Error) => consoleLines.push(`pageerror: ${e.message}`))
      viewA.on('worker', (w: Worker) => { w.on('console', (m: ConsoleMessage) => consoleLines.push(`worker: ${m.text()}`)) })
      await waitForPageGlobal(viewA, 'childHostE2e')
      const started = await evaluateRetrying(viewA, async () => await (globalThis as unknown as { childHostE2e: { start: () => Promise<ChildHostE2eResults> } }).childHostE2e.start()).catch((error: unknown) => {
        throw new Error(`${String(error)}\nconsole: ${consoleLines.join('\n')}`)
      })
      check('tab A started the forked heartbeat', started.started === true, JSON.stringify(started))
      const afterStart = await waitForCountAbove(viewA, 0).catch((error: unknown) => {
        throw new Error(`${String(error)}\nconsole: ${consoleLines.join('\n')}`)
      })

      const chrome = findChrome(app)
      await chrome.click('#new-tab')
      await waitFor(async () => (await tabIds(chrome)).length === 2)
      await waitForAddressBarStable(chrome)
      await clickAddressBarRetrying(chrome, `${ORIGIN}/second.html`)
      const navB = await waitForTab(chrome, { address: `${ORIGIN}/second.html`, title: TITLE })
      check('tab B navigates to the app\'s second page', navB.ok, navB.ok ? undefined : JSON.stringify(navB.info))
      const viewB = findViewShowing(app, chrome, `${ORIGIN}/second.html`)
      check('tab B is identifiable by its own URL', viewB !== undefined)
      if (viewB === undefined) return

      const idsBeforeClose = await tabIds(chrome)
      const tabAId = idsBeforeClose[0]
      check('two tabs are open before closing either', idsBeforeClose.length === 2, JSON.stringify(idsBeforeClose))

      await chrome.click(`[data-id="${tabAId}"] .close`)
      await waitFor(async () => (await tabIds(chrome)).length === 1)

      const afterCloseA = await waitForCountAbove(viewB, afterStart)
      check('closing tab A leaves the heartbeat running, observed from tab B, which never started it itself', afterCloseA > afterStart, `saw ${afterCloseA} after ${afterStart}`)

      // Tab B is now the app's ONLY page (its own separate phase, below,
      // reloads it rather than closing it -- proving the last-page rule a
      // second, independent way from the SAME running heartbeat, rather
      // than needing a fresh tab and a fresh child).
    })

    await runPhase('reloading an app\'s only page ends its children', async (check) => {
      const chrome = findChrome(app)
      const view = findViewShowing(app, chrome, `${ORIGIN}/second.html`)
      check('tab B, the app\'s only remaining page, is still identifiable by its own URL', view !== undefined)
      if (view === undefined) return

      const beforeReload = await heartbeatCount(view)
      check('the heartbeat is still running just before the reload', beforeReload > 0, `saw ${beforeReload}`)

      await view.reload()
      const stillRunning = await heartbeatStopped(view)
      check(
        'after reloading the app\'s only page, heartbeat.txt read back from the fresh page never advances -- the child from before the reload is gone',
        stillRunning,
        'heartbeat.txt kept advancing after the only page reloaded'
      )
    })

    await runPhase('a spawned program, routed through the host, outlives the tab that started it too', async (check) => {
      const served = await serveApp(app, SPAWN_ORIGIN, SPAWN_MANIFEST, 'tcp.listen.network', {
        '/index.html': new TextEncoder().encode(SPAWN_HTML),
        '/second.html': new TextEncoder().encode(SPAWN_HTML),
        '/app.js': await bundleForApp(fileURLToPath(new URL('./child-host-spawn-entry.ts', import.meta.url))),
        ...LISTENER_FILES
      }, [String(LISTENER_TARGET.port)], [{ capability: 'tcp.connect', patterns: [LISTENER_ADDRESS] }])
      check('the spawn fixture is granted tcp.listen.network and tcp.connect, and registered', served.granted && served.registered, JSON.stringify(served))

      // The only tab left standing from the phases above (at ORIGIN, not
      // SPAWN_ORIGIN) becomes tab A here: navigating it is a document change
      // like any other, so it carries no child of the earlier phases with it.
      await clickAddressBarRetrying(findChrome(app), `${SPAWN_ORIGIN}/`)
      const navA = await waitForTab(findChrome(app), { address: `${SPAWN_ORIGIN}/`, title: SPAWN_TITLE })
      check('the remaining tab navigates to the spawn fixture, becoming tab A', navA.ok, navA.ok ? undefined : JSON.stringify(navA.info))
      const viewA = findViewShowing(app, findChrome(app), `${SPAWN_ORIGIN}/`)
      check('tab A is identifiable by its own URL', viewA !== undefined)
      if (viewA === undefined) return

      await waitForPageGlobal(viewA, 'childHostSpawnE2e')
      const started = await evaluateRetrying(viewA, async () => await (globalThis as unknown as {
        childHostSpawnE2e: { start: () => Promise<ChildHostSpawnStartResult> }
      }).childHostSpawnE2e.start(), 30_000)
      check('tab A spawned the listener component through the child host, and it reported listening', started.started === true, JSON.stringify(started))

      const chrome = findChrome(app)
      await chrome.click('#new-tab')
      await waitFor(async () => (await tabIds(chrome)).length === 2)
      await waitForAddressBarStable(chrome)
      await clickAddressBarRetrying(chrome, `${SPAWN_ORIGIN}/second.html`)
      const navB = await waitForTab(chrome, { address: `${SPAWN_ORIGIN}/second.html`, title: SPAWN_TITLE })
      check('tab B navigates to the app\'s second page', navB.ok, navB.ok ? undefined : JSON.stringify(navB.info))
      const viewB = findViewShowing(app, chrome, `${SPAWN_ORIGIN}/second.html`)
      check('tab B is identifiable by its own URL', viewB !== undefined)
      if (viewB === undefined) return

      const idsBeforeClose = await tabIds(chrome)
      const tabAId = idsBeforeClose[0]
      check('two tabs are open before closing tab A', idsBeforeClose.length === 2, JSON.stringify(idsBeforeClose))

      await chrome.click(`[data-id="${tabAId}"] .close`)
      await waitFor(async () => (await tabIds(chrome)).length === 1)

      await waitForPageGlobal(viewB, 'childHostSpawnE2e')
      // The literal port, not `LISTENER_TARGET.port`: page.evaluate() sends
      // this closure's source to the browser as text, with no real closure
      // over this file's own scope -- an imported binding referenced here
      // becomes a dangling `__vite_ssr_import_N__` (measured), the same
      // reason ./e2e-child-process.test.ts's own listener phase hardcodes
      // its port rather than naming the constant inside its own evaluate.
      const echoed = await evaluateRetrying(viewB, async () => await (globalThis as unknown as {
        childHostSpawnE2e: { connectAndEcho: (port: number) => Promise<ChildHostSpawnEchoResult> }
      }).childHostSpawnE2e.connectAndEcho(8912), 30_000)
      check(
        'after closing tab A, tab B -- which never started it -- still reaches the spawned listener over its own port and gets its echo back',
        echoed.echoed === 'hello from a later tab\n', JSON.stringify(echoed)
      )

      // Tab B is now the app's only page: reloading it, this file's own
      // established stand-in for closing an app's last tab (the phase
      // above), ends the listener the same way ADR-0046 says closing would.
      // A refusal cannot be polled FOR (it may never stop being true, or
      // start out true for an unrelated reason): settle, then read once.
      await viewB.reload()
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const stillAnswers = await portAnswers(LISTENER_TARGET.port)
      check('after its own page ends, the listener\'s port no longer answers a fresh connection', !stillAnswers)
    })
  } finally {
    await closeElectronApp(app)
  }
}, 180_000)
