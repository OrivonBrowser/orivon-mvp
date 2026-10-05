// A `<name>.eth.limo` address opens as `<name>.eth` in the real shell: typed, followed as a link in the same tab or a
// new one, reached by a server redirect, and again through the web-request path when a tab holding a gateway address
// reloads after the setting is turned on. A gateway address inside a page's own frame, the gateway's own hosts, a name
// the verifier cannot load, and the setting off all stay as they are. The fixture `site.eth` is served by the
// test seam's gateway, so nothing leaves the machine.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Frame, Page } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from '../support/launch-electron.mjs'
import { ABSENCE_SETTLE_MS, activeTabInfo, delay, findChrome, findViewShowing, HERMETIC_RESOLVER, tabViews, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, runPhase, waitForAddressBarStable } from '../support/e2e-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 4 + DEFAULT_ACTION_TIMEOUT_MS * 12 + APP_CLOSE_RACE_MS + 120_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const PAGE = '<!doctype html><meta charset="utf-8"><title>gateway fixture page</title><body>page</body>'
const INDEX = '<!doctype html><meta charset="utf-8"><title>gateway fixture index</title><body>index</body>'

/** Every tab's own URL, as the main process holds it. */
async function tabUrls (app: ElectronApplication): Promise<string[]> {
  return await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((wc) => wc.getURL()))
}

async function toggleGatewaySetting (app: ElectronApplication, chrome: Page): Promise<void> {
  await chrome.evaluate(() => {
    (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/web3')
  })
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
  const page = app.windows().find((w: Page) => w.url().startsWith('orivon://settings')) as Page
  await page.waitForSelector('#row-web3-eth-gateway')
  await page.locator('#row-web3-eth-gateway input[type=checkbox]').click()
}

async function showTab (chrome: Page, id: string): Promise<void> {
  await chrome.click(`.tab[data-id="${id}"]`)
  expect(await waitFor(async () => (await activeTabInfo(chrome)).activeId === id)).toBe(true)
}

it('opens a .eth.limo address as the .eth name, and leaves everything else on the gateway', async () => {
  await runPhase('eth-gateway-redirect', async (check) => {
    const gateway = await startFixtureGateway({ site: { 'index.html': INDEX, 'page.html': PAGE } })
    const site = gateway.roots['site']!
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      if (request.url === '/go' || request.url === '/go-popup') {
        response.statusCode = 302
        response.setHeader('location', request.url === '/go' ? 'https://site.eth.limo/page.html?q=4#k' : 'https://site.eth.limo/page.html?q=5')
        response.end()
      } else if (request.url === '/popup') {
        response.end('<!doctype html><title>popup opener</title><button id="open" onclick="window.open(\'/go-popup\', \'\', \'width=400,height=400\')">open</button>')
      } else if (request.url === '/links') {
        response.end('<!doctype html><title>links</title><a id="same" href="https://site.eth.limo/page.html?q=2#kept">same</a> <a id="blank" target="_blank" href="https://site.eth.limo/page.html?q=3">blank</a>')
      } else {
        response.end('<!doctype html><title>frame host</title><iframe src="https://site.eth.limo/"></iframe>')
      }
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const loopback = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: {
          ORIVON_TEST_ETH_FIXTURES: JSON.stringify({ 'site.eth': `ipfs://${site}` }),
          ORIVON_TEST_IPFS_GATEWAYS: gateway.url,
          ORIVON_TEST_DOH: `${gateway.url}/dns-query`
        }
      })
      const running = app
      const listening = await waitFor(async () => await running.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 20_000)
      check('the verifier host is listening', listening)
      if (!listening) throw new Error('the verifier host never reported listening')

      await waitFor(() => running.windows().length === 2)
      const chrome = findChrome(running)
      await waitForAddressBarStable(chrome)
      const firstTab = (await activeTabInfo(chrome)).activeId as string

      // 1. Typed: the bar shows the .eth name, the view is at its own origin, and the query and fragment survive.
      await clickAddressBarRetrying(chrome, 'site.eth.limo/page.html?q=1#f')
      const typed = await waitForTab(chrome, { address: 'ipfs://site.eth/page.html?q=1#f', title: 'gateway fixture page' })
      check(`a typed gateway address opens as the .eth name (${JSON.stringify(typed.info)})`, typed.ok)
      check('the view is at https://site.eth/', findViewShowing(running, chrome, 'https://site.eth/page.html?q=1#f') !== undefined)

      // 2. A link in the same tab.
      await clickAddressBarRetrying(chrome, `${loopback}/links`)
      expect((await waitForTab(chrome, { title: 'links' })).ok).toBe(true)
      const links = tabViews(running, chrome).find((w: Page) => w.url() === `${loopback}/links`)
      if (links === undefined) throw new Error('the links page has no view')
      await links.click('#same').catch((error: unknown) => { if (!/closed/.test(String(error))) throw error })
      const same = await waitForTab(chrome, { address: 'ipfs://site.eth/page.html?q=2#kept', title: 'gateway fixture page' })
      check(`a same-tab gateway link opens the .eth name, keeping query and fragment (${JSON.stringify(same.info)})`, same.ok)

      // 3. A link that opens a new tab.
      await clickAddressBarRetrying(chrome, `${loopback}/links`)
      expect((await waitForTab(chrome, { title: 'links' })).ok).toBe(true)
      const before = await tabUrls(running)
      const linksAgain = tabViews(running, chrome).find((w: Page) => w.url() === `${loopback}/links`)
      if (linksAgain === undefined) throw new Error('the links page has no view')
      await linksAgain.click('#blank')
      const blank = await waitForTab(chrome, { address: 'ipfs://site.eth/page.html?q=3', title: 'gateway fixture page' })
      check(`a _blank gateway link opens the .eth name in a new tab (${JSON.stringify(blank.info)}, from ${before.length} views)`, blank.ok)
      check('the new tab is not the first', (await activeTabInfo(chrome)).activeId !== firstTab)

      // 4. A server redirect to a gateway address, caught by the web-request path.
      await clickAddressBarRetrying(chrome, `${loopback}/go`)
      let redirectedAddress: string | undefined
      await waitFor(async () => {
        redirectedAddress = ((await activeTabInfo(chrome)) as { address?: string }).address
        return redirectedAddress?.startsWith('ipfs://site.eth/page.html?q=4') === true
      })
      check(`a server redirect to a gateway address ends at the .eth name, fragment kept (${String(redirectedAddress)})`, redirectedAddress === 'ipfs://site.eth/page.html?q=4#k')

      // 4b. A popup that keeps its opener and is redirected by the server to a gateway address.
      await clickAddressBarRetrying(chrome, `${loopback}/popup`)
      expect((await waitForTab(chrome, { title: 'popup opener' })).ok).toBe(true)
      const opener = tabViews(running, chrome).find((w: Page) => w.url() === `${loopback}/popup`)
      if (opener === undefined) throw new Error('the popup opener has no view')
      await opener.click('#open').catch((error: unknown) => { if (!/closed/.test(String(error))) throw error })
      const popup = await waitForTab(chrome, { address: 'ipfs://site.eth/page.html?q=5', title: 'gateway fixture page' })
      check(`a popup that keeps its opener and is redirected to a gateway address opens the .eth name (${JSON.stringify(popup.info)})`, popup.ok)

      // 5. A gateway address in a page's own frame is untouched.
      await clickAddressBarRetrying(chrome, `${loopback}/frame`)
      expect((await waitForTab(chrome, { title: 'frame host' })).ok).toBe(true)
      await delay(ABSENCE_SETTLE_MS)
      const hostView = tabViews(running, chrome).find((w: Page) => w.url() === `${loopback}/frame`)
      const frameUrls = hostView?.frames().map((frame: Frame) => frame.url()) ?? []
      check(`the page stays and no frame is at https://site.eth/ (${JSON.stringify(frameUrls)})`, hostView !== undefined && !frameUrls.some((url: string) => url.startsWith('https://site.eth/')))
      check('the tab address is the page, not the name', (await activeTabInfo(chrome)).address === `${loopback}/frame`)

      // 6. The gateway's own hosts and a name nothing can load keep their host.
      const kept: string[] = []
      for (const [typedAddress, host] of [['eth.limo', 'https://eth.limo/'], ['www.eth.limo', 'https://www.eth.limo/'], ['dns.eth.limo', 'https://dns.eth.limo/'], ['other.eth.limo', 'https://other.eth.limo/']] as const) {
        await clickAddressBarRetrying(chrome, typedAddress)
        const stayed = await waitFor(async () => (await tabUrls(running)).includes(host))
        const urls = await tabUrls(running)
        if (!stayed || urls.some((url) => url.startsWith('https://other.eth/') || url.startsWith('https://www.eth/') || url.startsWith('https://dns.eth/'))) kept.push(`${typedAddress} -> ${JSON.stringify(urls)}`)
      }
      check(`eth.limo, www.eth.limo, dns.eth.limo and an unloadable name keep their host (${JSON.stringify(kept)})`, kept.length === 0)

      // 7. With the setting off a typed gateway address stays where it is.
      await showTab(chrome, firstTab)
      await toggleGatewaySetting(running, chrome)
      await showTab(chrome, firstTab)
      await clickAddressBarRetrying(chrome, 'site.eth.limo/')
      const stays = await waitFor(async () => (await tabUrls(running)).includes('https://site.eth.limo/'))
      const staysUrls = await tabUrls(running)
      check(`with the setting off the gateway address is loaded as typed (${JSON.stringify(staysUrls)})`, stays && !staysUrls.some((url) => url === 'https://site.eth/'))

      // 8. Setting it on again and reloading the tab goes through the web-request path alone.
      await toggleGatewaySetting(running, chrome)
      await showTab(chrome, firstTab)
      await chrome.click('#reload')
      const reloaded = await waitForTab(chrome, { address: 'ipfs://site.eth/', title: 'gateway fixture index' })
      check(`a reload of a tab holding a gateway address opens the .eth name (${JSON.stringify(reloaded.info)})`, reloaded.ok)
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() })
    }
  })
}, TEST_TIMEOUT_MS)
