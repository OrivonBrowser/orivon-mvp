// A website that runs in a session of its own (a tab set to a tunnel) waits for Chromium's network service to get its
// settings back like the shared session does. The service is ended with the settings held back for a while, a page is
// asked for in the tunnel profile's session inside that wait, and the SOCKS5 server the profile goes through is watched:
// it must not be asked for the name until the wait is over. Once with a tunnel profile session that existed before the
// service ended, once with one that is made while the requests are waiting.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { startSocks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import type { Socks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying, closeElectronApp } from '../support/e2e-helpers.js'
import { networkServicePid, seamOf, startCountedPage } from '../support/network-service-restart.js'
import type { CountedPage } from '../support/network-service-restart.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { activeTabInfo, delay, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

/** How long the new service's settings are held back, and the bound far above it, so that only the wait itself ends the hold. */
const PAD_MS = 6_000
const BOUND_MS = 20_000
/** Well inside the wait, long enough for a request that is not held to have reached the tunnel. */
const INSIDE_THE_WAIT_MS = 2_000

let page: CountedPage
let socks: Socks5Fixture

beforeAll(async () => {
  page = await startCountedPage((path) => (path === '/' ? 'tunnelled' : `tunnelled ${path.slice(1)}`))
  const real = { host: '127.0.0.1', port: page.port }
  socks = await startSocks5Fixture({ preferAuth: true, names: Object.fromEntries(['first', 'held', 'fresh'].map((name) => [`${name}.socks.test:${String(page.port)}`, real])) })
}, 60_000)

afterAll(async () => {
  await socks.close()
  await page.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const urlOf = (name: string, path = '/'): string => `http://${name}.socks.test:${String(page.port)}${path}`
const asked = (name: string): number => socks.requests.filter((request) => request.destination === `${name}.socks.test` && request.port === page.port).length

async function start (): Promise<{ app: ElectronApplication, chrome: Page }> {
  return await launchShell({
    env: { ORIVON_TEST_NETWORK_SERVICE_REAPPLY_DELAY_MS: String(PAD_MS), ORIVON_TEST_NETWORK_SERVICE_HOLD_BOUND_MS: String(BOUND_MS) },
    seedProfile: async (dir) => {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}` } }))
    }
  })
}

/** Gives the tab the SOCKS5 tunnel choice through the test seam, before it navigates. */
async function giveTunnel (app: ElectronApplication, chrome: Page): Promise<void> {
  const tab = (await activeTabInfo(chrome)).activeId as string
  const done = await app.evaluate((_electron, id) => (globalThis as unknown as { __orivonDevTabTunnel?: { set: (tab: string, choice: string | null) => boolean } }).__orivonDevTabTunnel?.set(id, 'socks5'), tab)
  expect(done, 'the test seam found the tab').toBe(true)
}

/** Ends the network service and waits until main has heard of it, so what is asked for next is asked for inside the wait. */
async function endNetworkService (app: ElectronApplication): Promise<void> {
  const pid = await networkServicePid(app)
  expect(pid).toBeGreaterThan(0)
  process.kill(pid, 'SIGKILL')
  expect(await waitFor(async () => (await seamOf(app)).ended === 1, 15_000)).toBe(true)
}

/** Asks for the page `name` in the active tab inside the wait: the tunnel is not asked for it while the settings are held back, and is once they are back. */
async function askInsideTheWait (app: ElectronApplication, chrome: Page, name: string): Promise<void> {
  const url = urlOf(name, `/${name}`)
  await clickAddressBarRetrying(chrome, url)
  await delay(INSIDE_THE_WAIT_MS)
  expect(asked(name), 'the request waits instead of reaching the tunnel').toBe(0)
  expect((await seamOf(app)).resent, 'the settings are still held back').toBe(0)
  expect((await waitForTab(chrome, { address: url, title: `tunnelled ${name}` }, 30_000)).ok, 'the page loads once the settings are back').toBe(true)
  const after = await seamOf(app)
  expect(asked(name)).toBeGreaterThan(0)
  expect(after.resent).toBe(1)
  expect(after.holds).toEqual([{ outcome: 'reapplied', requests: expect.any(Number) as number }])
  expect(after.holds[0]!.requests).toBeGreaterThanOrEqual(1)
}

it('holds a request in the tunnel profile session that existed when the network service ended', async () => {
  const { app, chrome } = await start()
  try {
    await giveTunnel(app, chrome)
    await clickAddressBarRetrying(chrome, urlOf('first'))
    expect((await waitForTab(chrome, { address: urlOf('first'), title: 'tunnelled' }, 30_000)).ok).toBe(true)
    expect(asked('first'), 'the first page went through the tunnel').toBeGreaterThan(0)
    await endNetworkService(app)
    await askInsideTheWait(app, chrome, 'held')
  } finally {
    await closeElectronApp(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('holds a request in a tunnel profile session made while the network service is being replaced', async () => {
  const { app, chrome } = await start()
  try {
    await giveTunnel(app, chrome)
    await endNetworkService(app)
    await askInsideTheWait(app, chrome, 'fresh')
  } finally {
    await closeElectronApp(app)
  }
}, QA_TEST_TIMEOUT_MS)
