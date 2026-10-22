// A website whose page failed to load, then sent through the person's own proxy from the tunnel button, loads there: the
// tab moves to the proxy's profile and loads the address again, and the sheet that said it could not load is gone. An onion
// address is the case that needs it most: nothing reaches one outside a tunnel, so the first try always fails. The SOCKS5
// fixture stands in for the proxy and maps the onion name to a page on loopback.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-tunnel-on-a-failed-page.test.ts
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { startSocks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import type { Socks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { popoverShown, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

/** A well-formed v3 onion name that exists nowhere but in the fixture. */
const ONION = 'orivonexampleonionaddressfailedfirstthentunnelledxxxxxxx.onion'
const SITE = `http://${ONION}`
const TITLE = 'reached-after-the-tunnel'

let app: ElectronApplication
let chrome: Page
let socks: Socks5Fixture
let page: Server

beforeAll(async () => {
  page = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>${TITLE}</title><body>${TITLE}</body>`) })
  await new Promise<void>((resolve) => { page.listen(0, '127.0.0.1', resolve) })
  const port = (page.address() as AddressInfo).port
  socks = await startSocks5Fixture({ preferAuth: true, refuseUnmapped: true, names: { [`${ONION}:80`]: { host: '127.0.0.1', port } } })
  const launched = await launchShell({
    seedProfile: async (userDataDir) => {
      // The proxy is set, and no site uses it yet.
      writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 2, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}` } }))
    }
  })
  app = launched.app
  chrome = launched.chrome
}, 240_000)

afterAll(async () => {
  await app?.close().catch(() => {})
  await socks?.close()
  await new Promise<void>((resolve) => { page?.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const windowShowing = (part: string): Page | undefined => app.windows().find((w) => w.url().includes(part) && !w.isClosed())

const sheetShown = async (): Promise<boolean> => await popoverShown(app, 'overlay=load-error')

it('[app:tunnel-on-a-failed-page] a page that failed to load, sent through the person\'s own proxy from the tunnel button, loads through it', async () => {
  await clickAddressBarRetrying(chrome, `${SITE}/`)
  expect((await waitForTab(chrome, { address: `${SITE}/` }, 60_000)).ok, 'the tab shows the address').toBe(true)
  expect(await waitFor(sheetShown, 30_000), 'the page could not load outside a tunnel, and the sheet says so').toBe(true)
  expect(socks.requests, 'nothing went to the proxy yet').toEqual([])

  await chrome.click('#tunnel-btn')
  expect(await waitFor(() => windowShowing('/site-info/') !== undefined)).toBe(true)
  const popover = windowShowing('/site-info/') as Page
  await popover.waitForSelector('#tunnel-switch-socks5')
  await popover.click('#tunnel-switch-socks5')
  // Moving a site to a profile of its own is asked first.
  if (await popover.locator('.tunnel-notice').count().catch(() => 0) > 0 || await waitFor(async () => await popover.locator('#tunnel-notice-confirm').count().catch(() => 0) > 0, 5_000)) {
    await popover.click('#tunnel-notice-confirm')
  }

  expect((await waitForTab(chrome, { address: `${SITE}/`, title: TITLE }, 60_000)).ok, 'the page loaded through the proxy').toBe(true)
  expect(socks.requests.some((request) => request.destination === ONION && request.addressType === 'domain'), JSON.stringify(socks.requests)).toBe(true)
  expect(await waitFor(async () => !(await sheetShown()), 15_000), 'the sheet that said it could not load is gone').toBe(true)
}, 4 * QA_TEST_TIMEOUT_MS)
