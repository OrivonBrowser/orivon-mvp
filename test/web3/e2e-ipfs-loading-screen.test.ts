// An `ipfs://` page the verifier is still gathering is covered by the protocol's loading screen, which says
// what is happening and goes away once the page's document is ready. Driven through the test seam's gateway
// with a delay on every block, so nothing leaves the machine and the load lasts long enough to look at.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { ABSENCE_SETTLE_MS, delay, findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { overlayShown, setScheme, waitOverlay } from '../support/auth-support.js'
import { QA_ROOT } from '../support/qa-evidence.mjs'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'

const BLOCK_DELAY_MS = 1_500
const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 6 + APP_CLOSE_RACE_MS + 90_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('covers the tab with the IPFS loading screen while the page loads, and takes it away when the page is ready', async () => {
  await runPhase('ipfs-loading-screen', async (check) => {
    const gateway = await startFixtureGateway({
      site: { 'index.html': '<!doctype html><meta charset="utf-8"><title>loading screen fixture</title><body>the page</body>' }
    }, { blockDelayMs: BLOCK_DELAY_MS })
    const site = gateway.roots['site']!
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: { ORIVON_TEST_ETH_FIXTURES: JSON.stringify({}), ORIVON_TEST_IPFS_GATEWAYS: gateway.url, ORIVON_TEST_DOH: `${gateway.url}/dns-query` }
      })
      const running = app
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      if (!listening) throw new Error('the verifier host never reported listening')
      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(app)
      await waitForAddressBarStable(chrome)

      await clickAddressBarRetrying(chrome, `ipfs://${site}`)
      const screen = await waitOverlay(running, 'loading-screen')
      const title = await screen.locator('.loading-screen-title').textContent()
      const address = await screen.locator('.loading-screen-address').getAttribute('title')
      const detail = await screen.locator('.loading-screen-detail').textContent()
      check(`the screen says what is happening (${JSON.stringify({ title, address, detail })})`, title === 'Loading from IPFS' && address === `ipfs://${site}/` && (detail ?? '').includes('content address'))
      const size = await screen.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      const window = await running.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]?.getContentBounds())
      check(`it fills the page area (${JSON.stringify({ size, window })})`, window !== undefined && size.width === window.width && size.height > 300)
      expect(await screen.locator('.loading-screen').getAttribute('aria-busy')).toBe('true')

      const evidence = join(QA_ROOT, 'latest')
      mkdirSync(evidence, { recursive: true })
      await setScheme(running, [chrome, screen], 'light')
      await screen.screenshot({ path: join(evidence, 'ipfs-loading-screen-light.png') })
      await setScheme(running, [chrome, screen], 'dark')
      await screen.screenshot({ path: join(evidence, 'ipfs-loading-screen-dark.png') })
      await setScheme(running, [chrome, screen], 'light')

      // The page's own title is the signal that it loaded; only then is its screen's absence worth reading.
      const loaded = await waitForTab(chrome, { address: `ipfs://${site}/`, title: 'loading screen fixture' }, 60_000)
      check(`the page loaded (${JSON.stringify(loaded.info)})`, loaded.ok)
      const gone = await waitFor(async () => !await overlayShown(running, 'loading-screen'), 10_000)
      await delay(ABSENCE_SETTLE_MS)
      const stillGone = !await overlayShown(running, 'loading-screen')
      check('the screen is gone once the page is ready, and stays gone', gone && stillGone)
      expect(title).toBe('Loading from IPFS')
      expect(address).toBe(`ipfs://${site}/`)
      expect(gone && stillGone).toBe(true)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
