// A `.eth` name or an `ipns://` DNSLink name the person turns the tunnel on for is read entirely through the tunnel: the
// verifier host fetches its blocks from the gateway, and asks DNS-over-HTTPS for its DNSLink, through the tunnel profile's
// front and the SOCKS5 fixture, with the name sent unresolved. Each gateway name has a decoy on the same port on loopback
// that serves the same site, so a fetch that skipped the tunnel would land on the decoy and be counted. With the tunnel
// stopped the site's files do not load, and nothing is asked of the decoy. The key and the popover show it fully tunnelled.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-website-tunnel-web3.test.ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { startSocks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import type { Socks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import { startFixtureGateway } from '../apps/ipfs-gateway/gateway.mjs'
import { shoot } from '../support/auth-support.js'
import { clickAddressBarRetrying, navigateToFixture } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { delay, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { closeTunnelList, pressAlways } from '../support/tunnel-popup.js'

const GATEWAY = 'gw.socks.test'
const DNSLINK_ORIGIN = 'https://docs-example.ipns.orivon'
const SITE = {
  'index.html': '<!doctype html><meta charset="utf-8"><title>eth fixture</title><body>eth fixture</body>',
  'other.html': '<!doctype html><meta charset="utf-8"><title>other fixture</title><body>other fixture</body>'
}
const OPTIONS = { dnslinks: { 'docs.example': 'tunnelled' } }

let dir: string
let socks: Socks5Fixture
let socksOpen = true
let real: Awaited<ReturnType<typeof startFixtureGateway>>
let decoy: Awaited<ReturnType<typeof startFixtureGateway>>
let app: ElectronApplication
let chrome: Page

const findPopup = (): Page | undefined => app.windows().find((w) => w.url().includes('/site-info/') && !w.isClosed())
const blocksAsked = (gateway: typeof real): number => gateway.requests.filter((request) => request.endsWith('?format=raw')).length
const lookupsAsked = (gateway: typeof real): number => gateway.requests.filter((request) => request.startsWith('/dns-query')).length

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-website-tunnel-web3-e2e-'))
  decoy = await startFixtureGateway({ tunnelled: SITE }, OPTIONS)
  real = await startFixtureGateway({ tunnelled: SITE }, OPTIONS)
  const decoyPort = new URL(decoy.url).port
  socks = await startSocks5Fixture({
    preferAuth: true,
    names: { [`${GATEWAY}:${decoyPort}`]: { host: '127.0.0.1', port: Number(new URL(real.url).port) } }
  })
  const launched = await launchShell({
    env: {
      ORIVON_TEST_ETH_FIXTURES: JSON.stringify({ 'tunnelled.eth': `ipfs://${real.roots['tunnelled']}` }),
      ORIVON_TEST_IPFS_GATEWAYS: `http://${GATEWAY}:${decoyPort}`,
      ORIVON_TEST_DOH: `http://${GATEWAY}:${decoyPort}/dns-query`
    },
    args: [`--host-resolver-rules=MAP ${GATEWAY} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`],
    seedProfile: async (userDataDir: string) => {
      writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}` } }))
      // The DNSLink name's site already has its entry, as one the person switched on in an earlier run would.
      writeFileSync(join(userDataDir, 'routes.json'), JSON.stringify({ version: 1, profiles: 1, origins: [DNSLINK_ORIGIN], off: [], apart: [DNSLINK_ORIGIN], apartDirect: [] }))
    }
  })
  app = launched.app
  chrome = launched.chrome
  const listening = await waitFor(async () => await app.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 30_000)
  if (!listening) throw new Error('the verifier host never reported listening')
}, 240_000)

afterAll(async () => {
  await app.close().catch(() => {})
  await decoy.close()
  await real.close()
  if (socksOpen) await socks.close()
  rmSync(dir, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function openPopover (): Promise<Page> {
  await chrome.click('#tunnel-btn')
  expect(await waitFor(() => findPopup() !== undefined)).toBe(true)
  const popover = findPopup() as Page
  await popover.waitForSelector('#tunnel-switch-socks5')
  return popover
}

it('[app:tunnelled-website-sends-nothing-direct] a .eth name with the tunnel on is read from its gateway through the tunnel, never directly, and is shown as fully tunnelled', async () => {
  await navigateToFixture(app, 'https://tunnelled.eth/', 'eth fixture')
  expect(blocksAsked(decoy), 'before the switch the verifier reads the gateway directly').toBeGreaterThan(0)
  expect(socks.requests.filter((request) => request.destination === GATEWAY)).toEqual([])

  const before = await openPopover()
  const lines = await before.locator('.tunnel-section .route-line').allTextContents()
  expect(lines.filter((line) => !line.startsWith('Address: ')), 'it says nothing is left outside before the switch, only what a row of the tab does').toEqual(['Pick a tunnel and every site you open in this tab goes through it, until the tab is closed.'])
  await before.click('#tunnel-switch-socks5')
  await before.waitForSelector('.tunnel-notice')
  await before.click('#tunnel-notice-confirm')

  // The tab moves to the tunnel profile and the page loads again, from the gateway through the tunnel.
  expect(await waitFor(async () => await app.evaluate(({ webContents, session }) => {
    const contents = webContents.getAllWebContents().find((wc) => wc.getURL() === 'https://tunnelled.eth/')
    return contents !== undefined && contents.session !== session.defaultSession && !contents.isLoading()
  }), 30_000)).toBe(true)
  expect((await waitForTab(chrome, { title: 'eth fixture' })).ok, 'the page loaded in the tunnel profile').toBe(true)
  const directBlocks = blocksAsked(decoy)
  expect(blocksAsked(real), 'the gateway was asked through the tunnel').toBeGreaterThan(0)
  expect(socks.requests.find((request) => request.destination === GATEWAY)?.userId, 'signed in to the tunnel with credentials of its own').toBeDefined()
  expect(socks.requests.map((request) => request.destination).filter((name) => name.endsWith('.eth')), 'the name itself never went to the tunnel').toEqual([])
  await delay(1000)
  expect(blocksAsked(decoy), 'and nothing further went to the gateway directly').toBe(directBlocks)

  expect(await waitFor(async () => await chrome.getAttribute('#tunnel-btn', 'data-tunnel') === 'on'), 'the tunnel button is purple').toBe(true)
  const after = await openPopover()
  expect(await after.locator('.tunnel-row[data-tunnel="socks5"] .tunnel-state').textContent(), 'the popover says nothing stays outside').toBe('This tab\'s traffic goes through your tunnel.')
  await shoot(app, chrome, after, 'website-tunnel-web3')

  // The row set the tab; "Always use for this site" keeps it for the name, which the tests below rely on.
  await pressAlways(app, chrome, 'socks5')
  await closeTunnelList(app, chrome)
}, 4 * QA_TEST_TIMEOUT_MS)

it('[app:tunnelled-website-sends-nothing-direct] an ipns:// DNSLink name with the tunnel on has its DNS-over-HTTPS lookup and its blocks sent through the tunnel', async () => {
  await clickAddressBarRetrying(chrome, 'ipns://docs.example')
  expect((await waitForTab(chrome, { address: 'ipns://docs.example/', title: 'eth fixture' })).ok, 'the DNSLink site loaded').toBe(true)
  expect(lookupsAsked(real), 'the DNSLink lookup arrived through the tunnel').toBeGreaterThan(0)
  expect(lookupsAsked(decoy), 'and never directly').toBe(0)
  expect(await waitFor(async () => await chrome.getAttribute('#tunnel-btn', 'data-tunnel') === 'on'), 'the tunnel button is purple').toBe(true)
}, 4 * QA_TEST_TIMEOUT_MS)

it('[app:tunnelled-website-sends-nothing-direct] with the tunnel stopped the site\'s files do not load, and nothing falls back to the gateway directly', async () => {
  await navigateToFixture(app, 'https://tunnelled.eth/', 'eth fixture')
  const directBlocks = blocksAsked(decoy)
  const directLookups = lookupsAsked(decoy)
  await socks.close()
  socksOpen = false

  await clickAddressBarRetrying(chrome, 'https://tunnelled.eth/other.html')
  await delay(8_000)
  const info = await waitForTab(chrome, { title: 'other fixture' }, 2_000)
  expect(info.ok, 'a file the verifier had not read yet did not load').toBe(false)
  expect(blocksAsked(decoy), 'nothing was asked of the gateway directly').toBe(directBlocks)
  expect(lookupsAsked(decoy)).toBe(directLookups)
}, 4 * QA_TEST_TIMEOUT_MS)
