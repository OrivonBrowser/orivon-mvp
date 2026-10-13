// A `.eth` name the person turns the tunnel on for keeps loading from Orivon's own verifier, which the tunnel does not
// carry: the name never goes to the tunnel (it would not resolve there), the page loads, and the popover and the key say
// plainly that only part of the site goes through the tunnel. The fixture gateway stands in for the network.
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
import { navigateToFixture } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { delay, findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

const SITE = { 'index.html': '<!doctype html><meta charset="utf-8"><title>eth fixture</title><body>eth fixture</body>' }

let dir: string
let socks: Socks5Fixture
let gateway: Awaited<ReturnType<typeof startFixtureGateway>>
let app: ElectronApplication
let chrome: Page

const findPopup = (): Page | undefined => app.windows().find((w) => w.url().includes('/site-info/') && !w.isClosed())

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-website-tunnel-web3-e2e-'))
  gateway = await startFixtureGateway({ tunnelled: SITE })
  socks = await startSocks5Fixture({ preferAuth: true })
  app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER],
    env: { ORIVON_TEST_ETH_FIXTURES: JSON.stringify({ 'tunnelled.eth': `ipfs://${gateway.roots['tunnelled']}` }), ORIVON_TEST_IPFS_GATEWAYS: gateway.url },
    seedProfile: async (userDataDir: string) => {
      writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}` } }))
    }
  })
  chrome = findChrome(app)
  const listening = await waitFor(async () => await app.evaluate(() => { const seam = (globalThis as { __orivonDevEthFixtures?: { listening: boolean, start?: () => void } }).__orivonDevEthFixtures; seam?.start?.(); return seam?.listening === true }), 30_000)
  if (!listening) throw new Error('the verifier host never reported listening')
}, 240_000)

afterAll(async () => {
  await app.close().catch(() => {})
  await gateway.close()
  await socks.close()
  rmSync(dir, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function openPopover (): Promise<Page> {
  await chrome.click('#site-permissions-btn')
  expect(await waitFor(() => findPopup() !== undefined)).toBe(true)
  const popover = findPopup() as Page
  await popover.waitForSelector('#tunnel-switch')
  return popover
}

it('[app:tunnelled-website-sends-nothing-direct] a .eth name with the tunnel on still loads from the verifier, is never asked of the tunnel, and is shown as only partly tunnelled', async () => {
  await navigateToFixture(app, 'https://tunnelled.eth/', 'eth fixture')

  const before = await openPopover()
  expect(await before.locator('.tunnel-section .route-line').textContent(), 'before the switch is turned on it says what stays outside').toBe('A Web3 name\'s own files come from Orivon itself and stay outside the tunnel for now.')
  await before.click('#tunnel-switch')
  await before.waitForSelector('.tunnel-notice')
  await before.click('#tunnel-notice-confirm')

  // The tab moves to the site's own session and the page loads again from the verifier, not from the tunnel.
  expect(await waitFor(async () => await app.evaluate(({ webContents, session }) => {
    const contents = webContents.getAllWebContents().find((wc) => wc.getURL() === 'https://tunnelled.eth/')
    return contents !== undefined && contents.session !== session.defaultSession && !contents.isLoading()
  }), 30_000)).toBe(true)
  expect((await waitForTab(chrome, { title: 'eth fixture' })).ok, 'the page loaded in its own session').toBe(true)
  await delay(1000)
  expect(socks.requests.map((request) => request.destination).filter((name) => name.endsWith('.eth')), 'the name never went to the tunnel').toEqual([])

  expect(await waitFor(async () => await chrome.getAttribute('#site-permissions-btn', 'data-tunnel') === 'partial'), 'the key says only part of it goes through the tunnel').toBe(true)
  const after = await openPopover()
  expect(await after.locator('.tunnel-section .route-line').last().textContent()).toBe('What this site asks of other sites goes through your tunnel. Its own files come from Orivon itself, outside the tunnel.')
  await shoot(app, chrome, after, 'website-tunnel-web3')
}, 4 * QA_TEST_TIMEOUT_MS)
