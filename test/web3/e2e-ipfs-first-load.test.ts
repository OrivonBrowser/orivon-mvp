// An `ipfs://` address typed in the first moments after launch, before the
// verifier host listens, loads: the request waits for the host rather than
// landing on the connection-refused page. The test seam holds the host's
// start for a few seconds so the address is always typed first.
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { findChrome, findViewShowing, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'

// Well under the gate's 10 s bound less a slow host start (~3 s): longer, and a slow machine releases the request before the host listens.
const START_DELAY_MS = 4_000
const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 4 + APP_CLOSE_RACE_MS + 60_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('loads an ipfs:// address typed before the verifier host listens', async () => {
  await runPhase('ipfs-first-load', async (check) => {
    const gateway = await startFixtureGateway({
      site: { 'index.html': '<!doctype html><meta charset="utf-8"><title>first load fixture</title><body>first</body>' }
    })
    const site = gateway.roots['site']!
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: {
          ORIVON_TEST_ETH_FIXTURES: JSON.stringify({}),
          ORIVON_TEST_IPFS_GATEWAYS: gateway.url,
          ORIVON_TEST_DOH: `${gateway.url}/dns-query`,
          ORIVON_TEST_VERIFIER_START_DELAY_MS: String(START_DELAY_MS)
        }
      })
      const running = app
      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(app)
      await waitForAddressBarStable(chrome)

      const listeningBefore = await running.evaluate(() => (globalThis as { __orivonDevEthFixtures?: { listening: boolean } }).__orivonDevEthFixtures?.listening === true)
      check('the verifier host is not listening yet when the address is typed', !listeningBefore)
      if (listeningBefore) throw new Error('the verifier host listened before the address was typed; the race was not exercised')

      await clickAddressBarRetrying(chrome, `ipfs://${site}`)
      let loaded = false
      await waitFor(async () => {
        loaded = (await waitForTab(chrome, { address: `ipfs://${site}/`, title: 'first load fixture' })).ok
        return loaded
      }, START_DELAY_MS + 30_000)
      check('the page loaded rather than landing on the connection-refused page', loaded)
      check('it runs at the https origin serving it', findViewShowing(app, chrome, `https://${site}.ipfs.orivon/`) !== undefined)
      expect(loaded).toBe(true)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
