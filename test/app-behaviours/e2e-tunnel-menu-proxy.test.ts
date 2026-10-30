// The person's proxy is set from the tunnel menu, without opening Settings. With no address saved, pressing the proxy's
// switch asks for one in place; an address that is not host:port is refused in the words of Settings and nothing is chosen; a
// good one is saved and the site then goes through the proxy (with the storage question a first move into the proxy's profile
// asks). Test says whether the proxy answers. Changing the address while a tab goes through the proxy asks first, naming how
// many; Cancel leaves the old address, Confirm saves the new one and the tab's site then goes through that. Every name has a
// decoy on the same port on loopback: a request that skipped the proxy would land on it.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-tunnel-menu-proxy.test.ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { startSocks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import type { Socks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import { shoot } from '../support/auth-support.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { delay, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { closeTunnelList } from '../support/tunnel-popup.js'

const SITE_NAME = 'site.proxy-menu.test'

let dir: string
let first: Socks5Fixture
let second: Socks5Fixture
let app: ElectronApplication
let chrome: Page
let decoy: { port: number, hits: () => number, close: () => Promise<void> }
let real: { port: number, close: () => Promise<void> }
const cleanups: Array<() => Promise<void> | void> = []
/** What the decoy had been asked when the site was last reached with no tunnel: nothing more may come after. */
let directHits = 0

async function host (title: string): Promise<{ port: number, hits: () => number, close: () => Promise<void> }> {
  let hits = 0
  const server = createServer((_request, response) => { hits += 1; response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>${title}</title><body>${title}</body>`) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return { port: (server.address() as AddressInfo).port, hits: () => hits, close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }) } }
}

const url = (): string => `http://${SITE_NAME}:${String(decoy.port)}/`
const findPopup = (): Page | undefined => app.windows().find((w) => w.url().includes('/site-info/') && !w.isClosed())

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-tunnel-menu-proxy-e2e-'))
  decoy = await host('direct')
  real = await host('through the proxy')
  const names = { [`${SITE_NAME}:${String(decoy.port)}`]: { host: '127.0.0.1', port: real.port } }
  first = await startSocks5Fixture({ preferAuth: true, names })
  second = await startSocks5Fixture({ preferAuth: true, names })
  cleanups.push(async () => { await decoy.close(); await real.close() }, async () => { await first.close(); await second.close() }, () => { rmSync(dir, { recursive: true, force: true }) })
  const launched = await launchShell({
    args: [`--host-resolver-rules=MAP ${SITE_NAME} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`],
    // No proxy address is saved: the menu is where it is set.
    seedProfile: async (userDataDir) => { writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 2, values: {} })) }
  })
  app = launched.app
  chrome = launched.chrome
}, 240_000)

afterAll(async () => {
  await app.close().catch(() => {})
  for (const cleanup of cleanups) await cleanup()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function openPopover (): Promise<Page> {
  if (findPopup() !== undefined) { await chrome.click('#tunnel-btn'); expect(await waitFor(() => findPopup() === undefined)).toBe(true); await delay(300) }
  await chrome.click('#tunnel-btn')
  expect(await waitFor(() => findPopup() !== undefined)).toBe(true)
  const popover = findPopup() as Page
  await popover.waitForSelector('#tunnel-switch-socks5')
  return popover
}

it('[app:tunnel-menu-sets-the-proxy] the proxy\'s switch asks for an address in place when none is saved, and an address that is not one is refused in the words of Settings', async () => {
  await clickAddressBarRetrying(chrome, url())
  expect((await waitForTab(chrome, { address: url(), title: 'direct' })).ok).toBe(true)
  const popover = await openPopover()
  expect(await popover.locator('#tunnel-proxy-address').count(), 'the field is there while no address is saved').toBe(1)
  expect(await popover.locator('#tunnel-proxy-address').getAttribute('placeholder')).toBe('127.0.0.1:9050')

  await popover.click('#tunnel-switch-socks5')
  expect(await popover.locator('#tunnel-switch-socks5').getAttribute('aria-checked'), 'pressing the switch chose nothing yet').toBe('false')
  await popover.fill('#tunnel-proxy-address', 'nonsense')
  await popover.click('#tunnel-proxy-save')
  await popover.waitForSelector('.route-line-down')
  expect(await popover.locator('.tunnel-address .route-line-down').textContent()).toBe('Enter an address as host:port, like 127.0.0.1:9050')
  expect(await popover.locator('#tunnel-proxy-address').inputValue(), 'what was typed is still there').toBe('nonsense')
  expect(first.requests.length + second.requests.length, 'nothing was sent anywhere').toBe(0)
  await shoot(app, chrome, popover, 'tunnel-menu-proxy-address')
}, 3 * QA_TEST_TIMEOUT_MS)

it('[app:tunnel-menu-sets-the-proxy] a good address is saved, the storage question follows, and the site then goes through the proxy and never reaches its decoy', async () => {
  const popover = await openPopover()
  directHits = decoy.hits()
  // The switch asked for the address, so saving it is what turns the proxy on.
  await popover.click('#tunnel-switch-socks5')
  await popover.fill('#tunnel-proxy-address', `127.0.0.1:${String(first.port)}`)
  await popover.click('#tunnel-proxy-save')
  await popover.waitForSelector('.tunnel-notice')
  expect(await popover.locator('#tunnel-switch-socks5').getAttribute('aria-checked'), 'saving the address turned the proxy on, after the question').toBe('true')
  await popover.click('#tunnel-notice-confirm')
  expect((await waitForTab(chrome, { address: url(), title: 'through the proxy' }, 60_000)).ok, 'the site came through the proxy').toBe(true)
  expect(first.requests.some((request) => request.destination === SITE_NAME)).toBe(true)
  expect(decoy.hits(), 'the decoy was asked only before the proxy').toBe(directHits)

  // The row set the tab only: the question about changing the address counts the tab, with no entry for the site.
  await closeTunnelList(app, chrome)
}, 4 * QA_TEST_TIMEOUT_MS)

it('[app:tunnel-menu-sets-the-proxy] the saved address is shown with Change, and Test says the proxy answers', async () => {
  const popover = await openPopover()
  expect(await popover.locator('.tunnel-address .route-line').textContent()).toBe(`Address: 127.0.0.1:${String(first.port)}`)
  expect(await popover.locator('#tunnel-proxy-change').textContent()).toBe('Change')
  await popover.click('#tunnel-test-socks5')
  await popover.waitForSelector('#tunnel-test-result-socks5')
  expect(await popover.locator('#tunnel-test-result-socks5').textContent()).toContain('The tunnel answered.')
  await shoot(app, chrome, popover, 'tunnel-menu-proxy-saved')
}, 3 * QA_TEST_TIMEOUT_MS)

it('[app:tunnel-menu-sets-the-proxy] changing the address while a tab goes through the proxy asks first, naming how many; Cancel keeps the old one and Confirm moves the tab to the new', async () => {
  const popover = await openPopover()
  await popover.click('#tunnel-proxy-change')
  await popover.fill('#tunnel-proxy-address', `127.0.0.1:${String(second.port)}`)
  await popover.click('#tunnel-proxy-save')
  await popover.waitForSelector('#tunnel-proxy-confirm')
  expect(await popover.locator('.tunnel-address .tunnel-notice-text').textContent()).toBe('1 tab goes through your proxy now. It will use the new address, and what it has open is closed.')
  await popover.click('#tunnel-proxy-cancel')
  expect(await popover.locator('.tunnel-address .route-line').textContent(), 'Cancel left the old address').toBe(`Address: 127.0.0.1:${String(first.port)}`)

  await popover.click('#tunnel-proxy-change')
  await popover.fill('#tunnel-proxy-address', `127.0.0.1:${String(second.port)}`)
  await popover.click('#tunnel-proxy-save')
  await popover.waitForSelector('#tunnel-proxy-confirm')
  await popover.click('#tunnel-proxy-confirm')
  await popover.waitForSelector('#tunnel-proxy-change')
  expect(await popover.locator('.tunnel-address .route-line').textContent()).toBe(`Address: 127.0.0.1:${String(second.port)}`)

  const before = second.requests.length
  await clickAddressBarRetrying(chrome, url())
  expect(await waitFor(() => second.requests.some((request) => request.destination === SITE_NAME), 60_000), 'the site now goes through the new address').toBe(true)
  expect(second.requests.length).toBeGreaterThan(before)
  expect(decoy.hits(), 'and never directly').toBe(directHits)
}, 4 * QA_TEST_TIMEOUT_MS)
