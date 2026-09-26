// The Website level and Delivery level on the Web3 Score page, and the
// toolbar shield, all read from the real popover: a `.eth` name whose
// content is IPFS is Website Level 2 and names its CID; one reached through
// a DNSLink is Website Level 2 as well, since IPFS content meets DDOC by
// design, but the DNS hop is forgeable, so it stays Delivery Level 1, not 2;
// an ordinary page is Website Level 1. None of them claims Website Level 3
// or above, or Delivery Level 3. Driven through the test seam, so no light
// client and no mainnet.
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
  deliveryHeading: string
  deliveryMet: string[]
  deliveryUnknown: string[]
  text: string
  /** The toolbar shield's own `data-level` (Website level), read from the
   * CHROME window at the moment the popup is opened -- `null` while no
   * level has resolved yet. */
  shieldLevel: string | null
  /** The wide shield's own "Web2"/"Web3" text, '' at L2/L3. */
  shieldText: string
}

function findPopup (app: ElectronApplication): Page | undefined {
  return app.windows().find((w) => w.url().includes('/site-info/'))
}

/** Opens the shield's Web3 Score page for the active tab, reads it (and the
 * shield's own painted state) and closes it again. */
async function readWeb3Page (app: ElectronApplication): Promise<Web3Page> {
  const chrome = findChrome(app)
  const shield = await chrome.evaluate(() => ({
    shieldLevel: document.querySelector('#web3-score-btn .web3-shield-fill')?.getAttribute('data-level') ?? null,
    shieldText: document.querySelector('#web3-score-btn .web3-shield-label')?.textContent ?? ''
  }))
  await chrome.click('#web3-score-btn')
  if (!await waitFor(() => findPopup(app) !== undefined, 5_000)) throw new Error('the Web3 Score popup did not open')
  const popup = findPopup(app)!
  if (!await waitFor(async () => (await popup.$$('.level-list')).length > 0, 5_000)) throw new Error('the Web3 Score page shows no level')
  const page = await popup.evaluate(() => ({
    // Each list's own heading is its immediately preceding sibling
    // (web3-view.ts's `levelSection`/`deliverySection`: heading, then
    // list) -- robust to whichever section happens to render first.
    heading: document.querySelector('.level-list')?.previousElementSibling?.textContent ?? '',
    met: [...document.querySelectorAll('.level-list .rung.met .rung-badge')].map((b) => b.textContent ?? ''),
    unknown: [...document.querySelectorAll('.level-list .rung.unknown .rung-badge')].map((b) => b.textContent ?? ''),
    deliveryHeading: document.querySelector('.delivery-list')?.previousElementSibling?.textContent ?? '',
    deliveryMet: [...document.querySelectorAll('.delivery-list .rung.met .rung-badge')].map((b) => b.textContent ?? ''),
    deliveryUnknown: [...document.querySelectorAll('.delivery-list .rung.unknown .rung-badge')].map((b) => b.textContent ?? ''),
    text: document.body.innerText
  }))
  await chrome.click('#web3-score-btn')
  await waitFor(() => findPopup(app) === undefined, 5_000)
  // Past popover-view.ts's reopen debounce, so the next click reads as a fresh open.
  await chrome.waitForTimeout(400)
  return { ...page, ...shield }
}

it('shows Website Level 2 for a .eth name, through a DNSLink too, Level 1 for an ordinary page, and never Level 3 or above; Delivery Level 2 only for the proven name, and the shield paints each', async () => {
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
      // A directly-named ipfs:// pointer's one contenthash hop verifies --
      // Delivery Level 2 (a proven name, content checked against its CID).
      check(`level.eth is Delivery level 2 (${level.deliveryHeading}; met ${level.deliveryMet.join(',')})`, level.deliveryHeading === 'Delivery level D2' && level.deliveryMet.join(',') === 'D1,D2')
      check(`the shield paints level 2, plain -- no Web2/Web3 text (shield=${String(level.shieldLevel)}/${level.shieldText})`, level.shieldLevel === '2' && level.shieldText === '')

      await navigateToFixture(app, 'https://linked.eth/', 'linked fixture')
      const linked = await readWeb3Page(app)
      check(`linked.eth, reached through a DNSLink, is Website level 2 (${linked.heading})`, linked.heading === 'Website level 2' && linked.met.join(',') === 'L1,L2')
      check('it names the DNSLink domain', linked.text.includes('Via DNS: app.example'))
      check('it still names the CID its files were checked against', linked.text.includes(`CID ${gateway.roots['linked']!}`))
      // The DNS hop anyone on the path could forge, so the name itself is
      // NOT proven -- Delivery stays Level 1, unlike the direct ipfs:// case.
      check(`linked.eth is Delivery level 1, not 2 (${linked.deliveryHeading}; met ${linked.deliveryMet.join(',')})`, linked.deliveryHeading === 'Delivery level D1' && linked.deliveryMet.join(',') === 'D1')
      check(`the shield paints level 2 for linked.eth too (Website, not Delivery) -- shield=${String(linked.shieldLevel)}`, linked.shieldLevel === '2')

      await navigateToFixture(app, ordinaryUrl, 'ordinary page')
      const plain = await readWeb3Page(app)
      check(`an ordinary page is Website level 1 (${plain.heading})`, plain.heading === 'Website level 1' && plain.met.join(',') === 'L1')
      check('it names nothing for a provider to assess', plain.text.includes('Nothing: this page has neither a CID nor a bundle hash.'))
      check(`it is Delivery level 1 too (${plain.deliveryHeading})`, plain.deliveryHeading === 'Delivery level D1' && plain.deliveryMet.join(',') === 'D1')
      check(`the shield paints level 1, "Web2" (shield=${String(plain.shieldLevel)}/${plain.shieldText})`, plain.shieldLevel === '1' && plain.shieldText === 'Web2')

      for (const [name, page] of [['level.eth', level], ['linked.eth', linked], ['ordinary', plain]] as const) {
        check(`${name} shows Website Levels 3 and 4 only as unknown`, page.unknown.join(',') === 'L3,L4' && !page.met.includes('L3') && !page.met.includes('L4'))
        check(`${name} shows Delivery Level 3 only as unknown, never claimed`, page.deliveryUnknown.join(',') === 'D3' && !page.deliveryMet.includes('D3'))
      }

      expect([level.heading, linked.heading, plain.heading]).toEqual(['Website level 2', 'Website level 2', 'Website level 1'])
      expect([level.deliveryHeading, linked.deliveryHeading, plain.deliveryHeading]).toEqual(['Delivery level D2', 'Delivery level D1', 'Delivery level D1'])
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      await gateway.close()
      ordinary.close()
    }
  })
}, TEST_TIMEOUT_MS)
