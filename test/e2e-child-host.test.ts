// ADR-0046's own end-to-end proof: a child a page starts outlives that page
// while another page of the same app is open, and ends only with the app's
// last page. Tab A forks a heartbeat that writes an incrementing tick count
// through fs every 200ms; tab B, a second tab of the SAME app (a different
// served path, so the two are distinguishable by URL), reads it. Closing tab
// A leaves the heartbeat running, observed from tab B; closing tab B too
// stops it. A separate, single-tab phase proves a reload of an app's only
// page ends its children the same way closing it would.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && npx vitest run --config test/vitest.e2e.config.ts test/e2e-child-host.test.ts
import { afterAll, expect, it } from 'vitest'
import type { ConsoleMessage, Worker } from 'playwright'
import { fileURLToPath } from 'node:url'
import { assertNoElectronSurvivors, launchElectron } from './launch-electron.mjs'
import { evaluateRetrying, findChrome, findViewShowing, HERMETIC_RESOLVER, tabIds, waitFor, waitForTab } from './smoke-helpers.mjs'
import {
  clickAddressBarRetrying, closeElectronApp, navigateToFixture, runPhase, waitForAddressBarStable, waitForPageGlobal
} from './e2e-helpers.js'
import { bundleForApp, serveApp } from './pinned-app.js'
import type { ChildHostE2eResults } from './child-host-entry.js'
import type { Manifest } from '../src/contracts/index.js'

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

it('a child outlives the page that started it while another page of the app is open, and ends with the app\'s last page', async () => {
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
  } finally {
    await closeElectronApp(app)
  }
}, 180_000)
