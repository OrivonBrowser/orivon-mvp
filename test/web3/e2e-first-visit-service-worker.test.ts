// A service worker in an app's own partition is served through the same handler as the page, before the app is
// pinned: its script, and what it fetches itself, are checked against the declared tree like every other file, so
// neither can run around the check. Driven through the test seam's gateway.
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { answerQuestion, noNativeDialogs, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import { pressSheet, savedGrants, sheetGone, waitSheet, watchPages, withDeclaredTree } from './first-visit-support.js'

const REGISTER = 'navigator.serviceWorker.register("sw.js").then(() => { document.body.dataset.sw = "registered" }, (error) => { document.body.dataset.sw = "failed: " + error })'

const files = (name: string, id: string, worker: string): Record<string, string> => ({
  'index.html': `<!doctype html><meta charset="utf-8"><title>${name}</title><link rel="orivon-manifest" href="/.well-known/orivon.json"><body>${name}<script src="app.js"></script></body>`,
  'app.js': REGISTER,
  'sw.js': worker,
  'probe.js': 'self.probed = "honest"',
  '.well-known/orivon.json': JSON.stringify({ orivonApiVersion: 0, id, name, version: '1.0.0', entry: 'index.html', assets: ['app.js', 'sw.js', 'probe.js'], capabilities: { fs: { quotaBytes: 1_048_576 } } })
})

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 12 + APP_CLOSE_RACE_MS + 180_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:first-visit-service-worker-is-checked] checks a service worker\'s script and its own fetches before the app is pinned, so neither runs around the declared tree', async () => {
  await runPhase('first-visit-service-worker', async (check) => {
    const honest = 'self.addEventListener("install", () => { fetch("/probe.js") })'
    const scripted = files('Script worker app', 'first.visit.sw.script', 'self.addEventListener("install", () => { console.log("BAD-WORKER-RAN") })')
    const fetching = files('Fetching worker app', 'first.visit.sw.fetch', honest)
    const gateway = await startFixtureGateway({
      fine: await withDeclaredTree(files('Fine worker app', 'first.visit.sw.fine', honest)),
      script: await withDeclaredTree(scripted, { ...scripted, 'sw.js': honest }),
      fetching: await withDeclaredTree({ ...fetching, 'probe.js': 'self.probed = "swapped"' }, fetching)
    })
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: { ORIVON_TEST_ETH_FIXTURES: '{}', ORIVON_TEST_IPFS_GATEWAYS: gateway.url, ORIVON_TEST_BACKGROUND_PIN_DELAY_MS: '600000' }
      })
      const running = app
      await stubNativeDialogs(running)
      await watchPages(running)
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      if (!listening) throw new Error('the verifier host never reported listening')
      const userData = await running.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(running)
      await waitForAddressBarStable(chrome)
      const swState = async (root: string): Promise<string | null> => await running.evaluate(async ({ webContents }, host) => {
        const contents = webContents.getAllWebContents().find((candidate) => !candidate.isDestroyed() && candidate.getURL().includes(host))
        if (contents === undefined) return null
        return await Promise.race([contents.executeJavaScript('document.body && document.body.dataset.sw ? document.body.dataset.sw : null') as Promise<string | null>, new Promise<null>((resolve) => setTimeout(() => { resolve(null) }, 2_000))]).catch(() => null)
      }, root).catch(() => null)

      // 1. The control: a worker whose bytes are the declared ones registers and runs in the app's own partition.
      const fineRoot = gateway.roots['fine']!
      await clickAddressBarRetrying(chrome, `ipfs://${fineRoot}`)
      await waitQuestion(running, 60_000)
      await answerQuestion(running, 'Allow')
      await waitForTab(chrome, { address: `ipfs://${fineRoot}/`, title: 'Fine worker app' }, 60_000)
      check('a worker with the declared bytes registers', await waitFor(async () => (await swState(fineRoot)) === 'registered', 30_000))

      // 2. A worker script that is not the declared one is never delivered.
      const scriptRoot = gateway.roots['script']!
      await clickAddressBarRetrying(chrome, `ipfs://${scriptRoot}`)
      await waitQuestion(running, 60_000)
      await answerQuestion(running, 'Allow')
      const scriptWarning = await waitSheet(running, 60_000)
      check(`a security warning names the worker (${JSON.stringify(scriptWarning.text.files)})`, /security warning/i.test(scriptWarning.text.title) && scriptWarning.text.files.includes('/sw.js'))
      check('its code never ran', !(await running.evaluate(() => (globalThis as { __pageLog?: string[] }).__pageLog ?? [])).some((line) => line.includes('BAD-WORKER-RAN')))
      check('no grant is left', savedGrants(userData, `https://${scriptRoot}.ipfs.orivon`).length === 0)
      await pressSheet(scriptWarning.page, 'Go back')
      check('Go back takes the sheet away', await waitFor(() => sheetGone(running), 10_000))

      // 3. What an honest worker fetches itself is checked too.
      const fetchingRoot = gateway.roots['fetching']!
      await clickAddressBarRetrying(chrome, `ipfs://${fetchingRoot}`)
      await waitQuestion(running, 60_000)
      await answerQuestion(running, 'Allow')
      const fetchWarning = await waitSheet(running, 60_000)
      check(`a security warning names what the worker fetched (${JSON.stringify(fetchWarning.text.files)})`, /security warning/i.test(fetchWarning.text.title) && fetchWarning.text.files.includes('/probe.js'))
      await pressSheet(fetchWarning.page, 'Go back')
      expect(await noNativeDialogs(running)).toEqual([])
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
