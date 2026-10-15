// An ipfs:// page is never read from a public gateway on the browser's own: when the node Orivon runs cannot give it, the
// tab shows a page that says so, with a "Load through public gateways" button, and not one request goes to a gateway until
// the button is pressed. The press loads this site, and only this site, through the gateways; another site is refused again.
// A fixture that answers nothing stands in for the node (the test seam), and a second fixture for the public gateways.
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { evaluateRetrying, findChrome, findViewShowing, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'

const RETRY_WAIT_MS = 1_000
const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 2 + DEFAULT_ACTION_TIMEOUT_MS * 10 + APP_CLOSE_RACE_MS + 120_000
const SITES = {
  one: { 'index.html': '<!doctype html><meta charset="utf-8"><title>consent one</title><h1>one</h1>' },
  two: { 'index.html': '<!doctype html><meta charset="utf-8"><title>consent two</title><h1>two</h1>' }
}

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[ipfs-gateway-consent] refuses to read a gateway until the person presses the button, then loads that site through them and no other', async () => {
  await runPhase('ipfs-gateway-consent', async (check) => {
    // The node: a fixture that answered once and then went away, so every read of it fails.
    const dead = await startFixtureGateway({})
    const nodeUrl = dead.url
    await dead.close()
    const publicGateway = await startFixtureGateway(SITES)
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: {
          ORIVON_TEST_ETH_FIXTURES: JSON.stringify({}),
          ORIVON_TEST_IPFS_GATEWAYS: publicGateway.url,
          ORIVON_TEST_DOH: `${publicGateway.url}/dns-query`,
          ORIVON_TEST_IPFS_NODE: nodeUrl,
          ORIVON_TEST_IPFS_NODE_RETRY_WAIT_MS: String(RETRY_WAIT_MS)
        }
      })
      const running = app
      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(app)
      await waitForAddressBarStable(chrome)

      const rootOne = publicGateway.roots['one']!
      const rootTwo = publicGateway.roots['two']!
      const shown = async (root: string): Promise<string> => {
        let text = ''
        await waitFor(async () => {
          const view = findViewShowing(running, chrome, `https://${root}.ipfs.orivon/`)
          if (view === undefined) return false
          text = await evaluateRetrying(view, () => document.body.innerText).catch(() => '')
          return text.includes('Load through public gateways')
        }, 90_000)
        return text
      }

      await clickAddressBarRetrying(chrome, `ipfs://${rootOne}`)
      const refused = await shown(rootOne)
      check(`the page says why and offers the gateways (${refused.slice(0, 160).replaceAll('\n', ' | ')})`, refused.includes('Orivon\'s IPFS node'))
      check(`no gateway was asked before the press (${JSON.stringify(publicGateway.requests)})`, publicGateway.requests.length === 0)
      expect(publicGateway.requests).toEqual([])

      const view = findViewShowing(running, chrome, `https://${rootOne}.ipfs.orivon/`)
      if (view === undefined) throw new Error('no view shows the refused site')
      // A real press: the browser marks a navigation the person started, and the host follows no other.
      await view.locator('#load-through-gateways').click()
      const loaded = await waitForTab(chrome, { title: 'consent one' }, 60_000)
      check(`the site loaded through the gateways (${JSON.stringify(loaded.info)})`, loaded.ok)
      check('the gateways were asked', publicGateway.requests.length > 0)
      expect(loaded.ok).toBe(true)

      // The yes is for this site: another site is refused again, and nothing more reaches a gateway for it.
      const before = publicGateway.requests.length
      await clickAddressBarRetrying(chrome, `ipfs://${rootTwo}`)
      const second = await shown(rootTwo)
      check('another site is refused again', second.includes('Load through public gateways'))
      check('and no gateway was asked for it', publicGateway.requests.length === before)
      expect(publicGateway.requests.length).toBe(before)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await publicGateway.close()
    }
  })
}, TEST_TIMEOUT_MS)
