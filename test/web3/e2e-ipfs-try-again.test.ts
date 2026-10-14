// A site that cannot be checked right now, then can: the page that says so offers Try again, and one
// click loads the site, though the failed attempt is remembered for a few seconds against a page's own
// subrequests. Driven through the test seam's gateway, so nothing leaves the machine.
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { evaluateRetrying, findChrome, findViewShowing, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 8 + APP_CLOSE_RACE_MS + 90_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('offers Try again on the unavailable page, and one click loads the site once its gateway recovers', async () => {
  await runPhase('ipfs-try-again', async (check) => {
    const gateway = await startFixtureGateway({
      site: { 'index.html': '<!doctype html><meta charset="utf-8"><title>recovered fixture</title><body>recovered</body>' }
    })
    const site = gateway.roots['site']!
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      gateway.failRoot('site', 503, 1_000)
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: { ORIVON_TEST_ETH_FIXTURES: '{}', ORIVON_TEST_IPFS_GATEWAYS: gateway.url }
      })
      const running = app
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      check('the verifier host is listening', listening)
      if (!listening) throw new Error('the verifier host never reported listening')

      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(running)
      await waitForAddressBarStable(chrome)
      await clickAddressBarRetrying(chrome, `ipfs://${site}`)
      const failed = await waitForTab(chrome, { title: 'Cannot check this site right now' }, 60_000)
      check(`the tab shows the unavailable page (${JSON.stringify(failed.info)})`, failed.ok)
      const view = findViewShowing(running, chrome, `https://${site}.ipfs.orivon/`)
      if (view === undefined) throw new Error('no view shows the served origin')
      const control = await evaluateRetrying(view, () => document.querySelector('a.retry')?.textContent ?? null)
      check(`the page offers Try again (${JSON.stringify(control)})`, control === 'Try again')

      // The gateway recovers; the failed attempt is still remembered, and the click is a person's own request.
      gateway.failRoot('site', 503, 0)
      await view.locator('a.retry').click()
      const loaded = await waitForTab(chrome, { address: `ipfs://${site}/`, title: 'recovered fixture' }, 60_000)
      check(`one click on Try again loaded the site (${JSON.stringify(loaded.info)})`, loaded.ok)

      expect(failed.ok).toBe(true)
      expect(control).toBe('Try again')
      expect(loaded.ok).toBe(true)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
