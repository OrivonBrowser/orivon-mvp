// The Website level on the Web3 Score page, read from the real popover: a
// `.eth` name whose content is IPFS is Level 2 and names its CID; one
// reached through a DNSLink is Level 2 as well, since IPFS content meets
// DDOC by design, but names the domain and leaves D4 unmet; an ordinary
// page is Level 1. None of them claims Level 3 or above. Driven through the
// test seam, so no light client and no mainnet.
import { afterAll, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from './launch-electron.mjs'
import { findChrome, HERMETIC_RESOLVER, waitFor } from './smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, closeElectronApp, navigateToFixture, runPhase } from './e2e-helpers.js'
import { startFixtureGateway } from './apps/ipfs-gateway/gateway.mjs'

const SITES = {
  level: { 'index.html': '<!doctype html><meta charset="utf-8"><title>level fixture</title><body>level</body>' },
  linked: { 'index.html': '<!doctype html><meta charset="utf-8"><title>linked fixture</title><body>linked</body>' }
}

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 3 + DEFAULT_ACTION_TIMEOUT_MS * 9 + APP_CLOSE_RACE_MS + 60_000

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface Web3Page {
  heading: string
  met: string[]
  unknown: string[]
  rungs: string[]
  text: string
}

function findPopup (app: ElectronApplication): Page | undefined {
  return app.windows().find((w) => w.url().includes('/site-info/'))
}

/** Opens the shield's Web3 Score page for the active tab, reads it, and closes it again. */
async function readWeb3Page (app: ElectronApplication): Promise<Web3Page> {
  const chrome = findChrome(app)
  await chrome.click('#web3-score-btn')
  if (!await waitFor(() => findPopup(app) !== undefined, 5_000)) throw new Error('the Web3 Score popup did not open')
  const popup = findPopup(app)!
  if (!await waitFor(async () => (await popup.$$('.level-list')).length > 0, 5_000)) throw new Error('the Web3 Score page shows no level')
  const page = await popup.evaluate(() => ({
    heading: document.querySelector('.section-heading')?.textContent ?? '',
    met: [...document.querySelectorAll('.level-list .rung.met .rung-badge')].map((b) => b.textContent ?? ''),
    unknown: [...document.querySelectorAll('.level-list .rung.unknown .rung-badge')].map((b) => b.textContent ?? ''),
    rungs: [...document.querySelectorAll('.rung-list:not(.level-list) .rung.met .rung-badge')].map((b) => b.textContent ?? ''),
    text: document.body.innerText
  }))
  await chrome.click('#web3-score-btn')
  await waitFor(() => findPopup(app) === undefined, 5_000)
  // Past popover-view.ts's reopen debounce, so the next click reads as a fresh open.
  await chrome.waitForTimeout(400)
  return page
}

it('shows Level 2 for a .eth name, through a DNSLink too, Level 1 for an ordinary page, and never Level 3 or above', async () => {
  await runPhase('eth-website-level', async (check) => {
    const gateway = await startFixtureGateway(SITES, { dnslinks: { 'app.example': 'linked' } })
    const ordinary = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>ordinary page</title><body>ordinary</body>') })
    await new Promise<void>((resolve) => { ordinary.listen(0, '127.0.0.1', resolve) })
    const ordinaryUrl = `http://127.0.0.1:${String((ordinary.address() as AddressInfo).port)}/`
    let app: ElectronApplication | undefined
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        env: {
          ORIVON_TEST_ETH_FIXTURES: JSON.stringify({ 'level.eth': `ipfs://${gateway.roots['level']!}`, 'linked.eth': 'dnslink://app.example' }),
          ORIVON_TEST_IPFS_GATEWAYS: gateway.url,
          ORIVON_TEST_DOH: `${gateway.url}/dns-query`
        }
      })
      const running = app
      const listening = await waitFor(async () => await running.evaluate(() => (globalThis as { __orivonDevEthFixtures?: { listening: boolean } }).__orivonDevEthFixtures?.listening === true), 20_000)
      if (!listening) throw new Error('the verifier host never reported listening')

      await navigateToFixture(app, 'https://level.eth/', 'level fixture')
      const level = await readWeb3Page(app)
      check(`level.eth is Website level 2 (${level.heading}; met ${level.met.join(',')})`, level.heading === 'Website level 2' && level.met.join(',') === 'L1,L2')
      check('it names its CID as what a provider would assess', level.text.includes(`CID ${gateway.roots['level']!}`))
      check('its name rows say how the name was reached', level.text.includes('A test fixture, not proven'))

      await navigateToFixture(app, 'https://linked.eth/', 'linked fixture')
      const linked = await readWeb3Page(app)
      check(`linked.eth, reached through a DNSLink, is Website level 2 (${linked.heading})`, linked.heading === 'Website level 2' && linked.met.join(',') === 'L1,L2')
      check(`it names the DNSLink domain, and meets D3 but not D4 (${linked.rungs.join(',')})`, linked.text.includes('Via DNS: app.example') && linked.rungs.includes('D3') && !linked.rungs.includes('D4'))
      check('it still names the CID its files were checked against', linked.text.includes(`CID ${gateway.roots['linked']!}`))

      await navigateToFixture(app, ordinaryUrl, 'ordinary page')
      const plain = await readWeb3Page(app)
      check(`an ordinary page is Website level 1 (${plain.heading})`, plain.heading === 'Website level 1' && plain.met.join(',') === 'L1')
      check('it names nothing for a provider to assess', plain.text.includes('Nothing: this page has neither a CID nor a bundle hash.'))

      for (const [name, page] of [['level.eth', level], ['linked.eth', linked], ['ordinary', plain]] as const) {
        check(`${name} shows Levels 3 and 4 only as unknown`, page.unknown.join(',') === 'L3,L4' && !page.met.includes('L3') && !page.met.includes('L4'))
      }

      expect([level.heading, linked.heading, plain.heading]).toEqual(['Website level 2', 'Website level 2', 'Website level 1'])
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
      ordinary.close()
    }
  })
}, TEST_TIMEOUT_MS)
