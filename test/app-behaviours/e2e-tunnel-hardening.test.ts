// With the whole browser on the tunnel, leaving a session that is not tunnelled for an ordinary website never lets the
// website's first request commit there: a link, a script's navigation and a sized `window.open` from a page in the direct
// profile, and the same three from an installed app the person set to off, all reach the website through the SOCKS5 fixture.
// Every name has a decoy on the same port on loopback (the host resolver maps the fixture's names there), so a request that
// skipped the proxy lands on a decoy and counts a hit.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-tunnel-hardening.test.ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { startSocks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import type { Socks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import type { Manifest } from '../../src/contracts/index.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { activeTabInfo, delay, findViewShowing, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { serveApp } from '../node-runtime/pinned-app.js'

const PLAIN = 'plain.socks.test'
const OFF = 'off.socks.test'
const APP_ORIGIN = 'https://tunnel-hardening-e2e.orivon.test'
const ROUTE_CHOICE = '.app-card:has-text("tunnel-hardening") .app-route select'

interface Hosted { port: number, hits: number, close: () => Promise<void> }

async function host (answer: (request: IncomingMessage, response: ServerResponse) => void): Promise<Hosted> {
  const hosted: Hosted = { port: 0, hits: 0, close: async () => {} }
  const server = createServer((request, response) => { hosted.hits += 1; answer(request, response) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  hosted.port = (server.address() as AddressInfo).port
  hosted.close = async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }) }
  return hosted
}

let dir: string
let socks: Socks5Fixture
let app: ElectronApplication
let chrome: Page
const hosts: Record<'plainDecoy' | 'plainReal' | 'offDecoy', Hosted> = {} as never
const cleanups: Array<() => Promise<void> | void> = []

const plainUrl = (): string => `http://${PLAIN}:${String(hosts.plainDecoy.port)}/`
const offUrl = (): string => `http://${OFF}:${String(hosts.offDecoy.port)}/`
const asked = (): number => socks.requests.filter((request) => request.destination === PLAIN && request.port === hosts.plainDecoy.port).length
const tabTitle = async (): Promise<string> => (await activeTabInfo(chrome)).title

/** The script that makes the buttons of a page that leaves work: an app's page runs under a policy that forbids inline handlers. */
const behaviour = (): string => `document.getElementById('script').addEventListener('click', () => { location.assign('${plainUrl()}') })
document.getElementById('pop').addEventListener('click', () => { window.open('${plainUrl()}', 'pop', 'width=400,height=300') })`

/** What a page that leaves for the ordinary website offers: a link, a script navigation and a sized popup. */
const leaving = (title: string, script: string): string => `<!doctype html><title>${title}</title><body>
<a id="go" href="${plainUrl()}">link</a><button id="script">script</button><button id="pop">popup</button>${script}</body>`

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-tunnel-hardening-e2e-'))
  hosts.plainDecoy = await host((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>direct</title><body>direct</body>') })
  hosts.plainReal = await host((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>tunnelled</title><body>tunnelled</body>') })
  hosts.offDecoy = await host((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }).end(leaving('direct profile page', `<script>${behaviour()}</script>`)) })
  socks = await startSocks5Fixture({
    preferAuth: true,
    names: { [`${PLAIN}:${String(hosts.plainDecoy.port)}`]: { host: '127.0.0.1', port: hosts.plainReal.port } }
  })
  cleanups.push(...Object.values(hosts).map((one) => () => one.close()), async () => { await socks.close() }, () => { rmSync(dir, { recursive: true, force: true }) })

  const launched = await launchShell({
    args: [`--host-resolver-rules=MAP ${PLAIN} 127.0.0.1, MAP ${OFF} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`],
    seedProfile: async (userDataDir) => {
      writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}`, 'network.tunnel.everywhere': true } }))
      // The page that leaves is a website set to off, which lives in the direct profile.
      const site = `http://${OFF}:${String(hosts.offDecoy.port)}`
      writeFileSync(join(userDataDir, 'routes.json'), JSON.stringify({ version: 1, profiles: 1, origins: [], off: [site], apart: [], apartDirect: [site] }))
    }
  })
  app = launched.app
  chrome = launched.chrome

  const manifest: Manifest = { orivonApiVersion: 0, id: 'app.orivon.behaviour.tunnel-hardening', name: 'Behaviour tunnel-hardening', version: '1.0.0', entry: 'index.html', capabilities: { net: { tcp: { connect: ['127.0.0.1:1'] } } } }
  const served = await serveApp(app, APP_ORIGIN, manifest, 'tcp.connect', { '/index.html': new TextEncoder().encode(leaving('app page', '<script src="/app.js"></script>')), '/app.js': new TextEncoder().encode(behaviour()) }, ['127.0.0.1:1'], [])
  expect(served).toEqual({ granted: true, registered: true })
}, 240_000)

afterAll(async () => {
  await app.close().catch(() => {})
  for (const cleanup of cleanups) await cleanup()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function open (url: string, title: string): Promise<Page> {
  await clickAddressBarRetrying(chrome, url)
  expect((await waitForTab(chrome, { address: url, title })).ok).toBe(true)
  expect(await waitFor(() => findViewShowing(app, chrome, url) !== undefined)).toBe(true)
  const page = findViewShowing(app, chrome, url) as Page
  await page.waitForLoadState('load')
  return page
}

/** Presses `selector` in the page and waits for the ordinary website to be asked of the tunnel, then checks nothing reached its decoy. */
async function leaveBy (page: Page, selector: string): Promise<void> {
  const before = asked()
  await page.click(selector)
  expect(await waitFor(() => asked() > before, 30_000), `${selector}: the website was asked of the tunnel`).toBe(true)
  await delay(1000)
  expect(hosts.plainDecoy.hits, `${selector}: the first request never reached the website directly`).toBe(0)
}

it('[app:tunnel-hardening-direct-profile-leaves-through-the-tunnel] a link, a script navigation and a sized popup from a page in the direct profile reach an ordinary website through the tunnel, never direct', async () => {
  let page = await open(offUrl(), 'direct profile page')
  expect(await app.evaluate(({ webContents, session }, url) => webContents.getAllWebContents().find((wc) => wc.getURL() === url)?.session === session.defaultSession, offUrl()), 'the page lives in the direct profile, not the shared session').toBe(false)

  await leaveBy(page, '#go')
  expect(await waitFor(async () => await tabTitle() === 'tunnelled', 30_000)).toBe(true)

  page = await open(offUrl(), 'direct profile page')
  await leaveBy(page, '#script')
  expect(await waitFor(async () => await tabTitle() === 'tunnelled', 30_000)).toBe(true)

  page = await open(offUrl(), 'direct profile page')
  await leaveBy(page, '#pop')
}, 6 * QA_TEST_TIMEOUT_MS)

async function openApps (): Promise<Page> {
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/apps') })
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
  const settings = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
  await settings.waitForSelector(ROUTE_CHOICE)
  return settings
}

it('[app:tunnel-hardening-app-set-to-off-leaves-through-the-tunnel] the same three from an installed app set to off reach an ordinary website through the tunnel, never direct', async () => {
  const settings = await openApps()
  expect(await settings.locator(ROUTE_CHOICE).inputValue(), 'the app follows the default, which is the proxy').toBe('socks5')
  await settings.locator(ROUTE_CHOICE).selectOption('')
  expect(await waitFor(async () => await settings.locator(ROUTE_CHOICE).inputValue() === '')).toBe(true)
  await settings.close()

  let page = await open(`${APP_ORIGIN}/`, 'app page')
  await leaveBy(page, '#go')
  expect(await waitFor(async () => await tabTitle() === 'tunnelled', 30_000)).toBe(true)

  page = await open(`${APP_ORIGIN}/`, 'app page')
  await leaveBy(page, '#script')
  expect(await waitFor(async () => await tabTitle() === 'tunnelled', 30_000)).toBe(true)

  page = await open(`${APP_ORIGIN}/`, 'app page')
  await leaveBy(page, '#pop')
}, 6 * QA_TEST_TIMEOUT_MS)
