// The verifier keeps one cache per top-level page origin (A256), read from
// the fixture gateway's request log, since a cold cache is exactly what
// makes the verifier ask the gateway for a site's root block again:
// - a `.eth` name opened in a tab is cold for a request another site's
//   page makes to it, so that page's timing tells it nothing;
// - that page's second request is warm, so the shell really did stamp its
//   requests with its own partition rather than leaving them unshared;
// - the name's own tab stays warm throughout.
import { afterAll, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication } from 'playwright'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from './launch-electron.mjs'
import { HERMETIC_RESOLVER, waitFor } from './smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, closeElectronApp, navigateToFixture, runPhase } from './e2e-helpers.js'
import { startFixtureGateway } from './apps/ipfs-gateway/gateway.mjs'

const SITE = {
  'index.html': '<!doctype html><meta charset="utf-8"><title>shared fixture</title><body>shared</body>',
  'data.txt': 'data'
}

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 3 + DEFAULT_ACTION_TIMEOUT_MS * 6 + APP_CLOSE_RACE_MS + 60_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it("keeps a .eth name one site opened cold for every other site's pages", async () => {
  await runPhase('eth-partition', async (check) => {
    const gateway = await startFixtureGateway({ shared: SITE })
    const root = gateway.roots['shared']!
    const rootAsks = (): number => gateway.requests.filter((r) => r.includes(root)).length
    const other = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>other site</title><body>other</body>') })
    await new Promise<void>((resolve) => { other.listen(0, '127.0.0.1', resolve) })
    const otherUrl = `http://127.0.0.1:${String((other.address() as AddressInfo).port)}/`
    let app: ElectronApplication | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: { ORIVON_TEST_ETH_FIXTURES: JSON.stringify({ 'shared.eth': `ipfs://${root}` }), ORIVON_TEST_IPFS_GATEWAYS: gateway.url }
      })
      const running = app
      const listening = await waitFor(async () => await running.evaluate(() => (globalThis as { __orivonDevEthFixtures?: { listening: boolean } }).__orivonDevEthFixtures?.listening === true), 20_000)
      if (!listening) throw new Error('the verifier host never reported listening')

      await navigateToFixture(app, 'https://shared.eth/', 'shared fixture')
      const afterOwnTab = rootAsks()
      check(`opening shared.eth asked the gateway for its root (${String(afterOwnTab)})`, afterOwnTab === 1)

      const page = await navigateToFixture(app, otherUrl, 'other site')
      const fetchFromOther = async (): Promise<string> => await page.evaluate(async () => {
        try {
          await fetch('https://shared.eth/data.txt', { mode: 'no-cors', cache: 'no-store' })
          return 'answered'
        } catch (error) {
          return String(error)
        }
      })
      const first = await fetchFromOther()
      const afterFirst = rootAsks()
      check(`another site's first request found shared.eth cold, so the gateway was asked again (${first}; ${String(afterFirst)})`, afterFirst === 2)
      const second = await fetchFromOther()
      const afterSecond = rootAsks()
      check(`its second request found its own partition warm (${second}; ${String(afterSecond)})`, afterSecond === 2)

      await navigateToFixture(app, 'https://shared.eth/', 'shared fixture')
      const afterReturn = rootAsks()
      check(`shared.eth's own tab is still warm (${String(afterReturn)})`, afterReturn === 2)

      expect([afterOwnTab, afterFirst, afterSecond, afterReturn]).toEqual([1, 2, 2, 2])
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
      other.close()
    }
  })
}, TEST_TIMEOUT_MS)
