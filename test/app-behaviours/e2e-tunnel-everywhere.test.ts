// "Send all of Orivon's traffic through the tunnel": with the setting on, a plain website with no setting of its own is
// loaded in the shared session, which is then pointed at the shared front, so its page, a subresource from another host,
// a WebSocket and its tab icon all arrive through the SOCKS5 fixture. A site the person sets to off from its popover and
// keeps with "Always use for this site" moves to the direct profile and arrives direct, from its own storage, and turning
// the setting off and on again moves no website. With the fixture stopped, everything fails and nothing arrives direct.
// Every name has a decoy on the same port on loopback: the host resolver maps the fixture's names there, so a request that
// skipped the proxy lands on a decoy and counts a hit.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-tunnel-everywhere.test.ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { startSocks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import type { Socks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { shoot } from '../support/auth-support.js'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { activeTabInfo, delay, findViewShowing, tabIds, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { closeTunnelList, pressAlways } from '../support/tunnel-popup.js'

const PLAIN = 'plain.socks.test'
const OFF = 'off.socks.test'
const CDN = 'cdn.socks.test'
const WS = 'ws.socks.test'
const DIRECT_NOTICE = 'This site moves to your direct profile. You\'ll sign in to it again once, and what it stores stays apart from your normal browsing.'
const TUNNEL_NAME = 'Your proxy'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

interface Hosted { port: number, hits: number, paths: string[], close: () => Promise<void> }

async function host (answer: (request: IncomingMessage, response: ServerResponse) => void): Promise<Hosted> {
  const hosted: Hosted = { port: 0, hits: 0, paths: [], close: async () => {} }
  const server = createServer((request, response) => { hosted.hits += 1; hosted.paths.push(request.url ?? ''); answer(request, response) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  hosted.port = (server.address() as AddressInfo).port
  hosted.close = async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }) }
  return hosted
}

let dir: string
let socks: Socks5Fixture
let app: ElectronApplication
let chrome: Page
let websockets: WebSocketServer
const hosts: Record<'plainDecoy' | 'plainReal' | 'offDecoy' | 'offReal' | 'cdnDecoy' | 'cdnReal' | 'wsDecoy', Hosted> = {} as never
const cleanups: Array<() => Promise<void> | void> = []

const origin = (name: string, port: number): string => `http://${name}:${String(port)}`
const plainUrl = (): string => `${origin(PLAIN, hosts.plainDecoy.port)}/`
const offUrl = (): string => `${origin(OFF, hosts.offDecoy.port)}/`
const asked = (name: string, port: number): number => socks.requests.filter((request) => request.destination === name && request.port === port).length
const findPopup = (): Page | undefined => app.windows().find((w) => w.url().includes('/site-info/') && !w.isClosed())

const page = (title: string, cookie: string, extra = '') => (_request: IncomingMessage, response: ServerResponse): void => {
  response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `who=${cookie}; Path=/` })
  response.end(`<!doctype html><title>${title}</title><link rel="icon" href="/icon.png"><body>${title}<img src="http://${CDN}:${String(hosts.cdnDecoy.port)}/pic.png">${extra}</body>`)
}
const png = (_request: IncomingMessage, response: ServerResponse): void => {
  response.writeHead(200, { 'content-type': 'image/png' })
  response.end(PNG)
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-tunnel-everywhere-e2e-'))
  hosts.cdnDecoy = await host(png)
  hosts.cdnReal = await host(png)
  hosts.wsDecoy = await host((_request, response) => { response.writeHead(404).end() })
  websockets = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((resolve) => { websockets.on('listening', resolve) })
  websockets.on('connection', (socket) => { socket.send('hello over websocket') })
  const script = `<script>const socket = new WebSocket('ws://${WS}:${String(hosts.wsDecoy.port)}/'); socket.onmessage = (event) => { document.body.dataset.ws = event.data }</script>`
  const imagesOrPage = (title: string, cookie: string, extra = ''): ((request: IncomingMessage, response: ServerResponse) => void) => (request, response) => {
    if (request.url === '/icon.png') png(request, response)
    else page(title, cookie, extra)(request, response)
  }
  hosts.plainDecoy = await host(imagesOrPage('direct', 'shared'))
  hosts.plainReal = await host(imagesOrPage('tunnelled', 'tunnel', script))
  hosts.offDecoy = await host(imagesOrPage('direct', 'direct-profile'))
  hosts.offReal = await host(imagesOrPage('tunnelled', 'tunnel'))
  socks = await startSocks5Fixture({
    preferAuth: true,
    names: {
      [`${PLAIN}:${String(hosts.plainDecoy.port)}`]: { host: '127.0.0.1', port: hosts.plainReal.port },
      [`${OFF}:${String(hosts.offDecoy.port)}`]: { host: '127.0.0.1', port: hosts.offReal.port },
      [`${CDN}:${String(hosts.cdnDecoy.port)}`]: { host: '127.0.0.1', port: hosts.cdnReal.port },
      [`${WS}:${String(hosts.wsDecoy.port)}`]: { host: '127.0.0.1', port: (websockets.address() as AddressInfo).port }
    }
  })
  cleanups.push(
    ...Object.values(hosts).map((one) => () => one.close()),
    async () => { await new Promise<void>((resolve) => { websockets.close(() => { resolve() }) }) },
    async () => { await socks.close() },
    () => { rmSync(dir, { recursive: true, force: true }) }
  )

  const launched = await launchShell({
    args: [`--host-resolver-rules=MAP ${PLAIN} 127.0.0.1, MAP ${OFF} 127.0.0.1, MAP ${CDN} 127.0.0.1, MAP ${WS} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`],
    seedProfile: async (userDataDir) => {
      writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}`, 'network.tunnel.everywhere': true } }))
    }
  })
  app = launched.app
  chrome = launched.chrome
}, 240_000)

afterAll(async () => {
  await app.close().catch(() => {})
  for (const cleanup of cleanups) await cleanup()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function open (url: string, title: string): Promise<void> {
  await clickAddressBarRetrying(chrome, url)
  expect((await waitForTab(chrome, { address: url, title })).ok).toBe(true)
}

const tabTitle = async (): Promise<string> => (await activeTabInfo(chrome)).title

async function openPopover (): Promise<Page> {
  await chrome.click('#tunnel-btn')
  expect(await waitFor(() => findPopup() !== undefined)).toBe(true)
  const popover = findPopup() as Page
  await popover.waitForSelector('#tunnel-switch-socks5')
  return popover
}

async function closePopover (): Promise<void> {
  await chrome.click('#tunnel-btn')
  expect(await waitFor(() => findPopup() === undefined)).toBe(true)
  await delay(300)
}

/** Cookies of a session, by name, for a host: the default session when `partition` is undefined. */
async function cookies (partition: string | undefined, domain: string): Promise<string[]> {
  return await app.evaluate(async ({ session }, args) => {
    const where = args.partition === undefined ? session.defaultSession : session.fromPartition(args.partition)
    return (await where.cookies.get({ domain: args.domain })).map((cookie) => `${cookie.name}=${cookie.value}`)
  }, { partition, domain })
}

const sessionOfTab = async (address: string): Promise<{ isDefault: boolean, webrtc: string } | null> => await app.evaluate(({ webContents, session }, url) => {
  const contents = webContents.getAllWebContents().find((wc) => wc.getURL() === url)
  return contents === undefined ? null : { isDefault: contents.session === session.defaultSession, webrtc: contents.getWebRTCIPHandlingPolicy() }
}, address)

async function openSettingsPrivacy (): Promise<Page> {
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/tunnels') })
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
  return app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
}

it('[app:tunnel-everywhere-carries-a-plain-website] a website with no setting of its own arrives through the tunnel in the shared session, with its subresource, WebSocket and tab icon', async () => {
  await open(plainUrl(), 'tunnelled')

  expect(await sessionOfTab(plainUrl()), 'it lives in the shared session, with WebRTC confined').toEqual({ isDefault: true, webrtc: 'disable_non_proxied_udp' })
  expect(asked(PLAIN, hosts.plainDecoy.port), 'the page came through the tunnel').toBeGreaterThan(0)
  expect(await waitFor(() => asked(CDN, hosts.cdnDecoy.port) > 0), 'and so did its image from another host').toBe(true)
  const view = await waitFor(() => findViewShowing(app, chrome, plainUrl()) !== undefined) ? findViewShowing(app, chrome, plainUrl()) as Page : undefined
  expect(await waitFor(async () => await view?.evaluate(() => document.body.dataset['ws']) === 'hello over websocket'), 'a WebSocket arrived through the tunnel').toBe(true)
  expect(asked(WS, hosts.wsDecoy.port)).toBeGreaterThan(0)
  expect(await waitFor(() => hosts.plainReal.paths.includes('/icon.png')), 'the tab icon was fetched by main through the tunnel').toBe(true)
  expect(socks.requests.find((request) => request.destination === PLAIN)?.userId, 'it signed in to the tunnel').toBeDefined()

  expect(hosts.plainDecoy.hits + hosts.cdnDecoy.hits + hosts.wsDecoy.hits, 'nothing reached a decoy').toBe(0)
  expect(await cookies(undefined, PLAIN), 'its cookie is in the shared session, which the tunnel carries').toEqual(['who=tunnel'])
  expect(await chrome.getAttribute('#tunnel-btn', 'data-tunnel'), 'the tunnel button is purple: the tab goes through the tunnel').toBe('on')
  await shoot(app, chrome, chrome, 'tunnel-everywhere-key')

  const popover = await openPopover()
  expect(await popover.locator('#tunnel-tab-browser').getAttribute('aria-selected'), 'a website that follows the browser opens on the Browser-wide panel').toBe('true')
  expect(await popover.locator('#tunnel-switch-socks5').getAttribute('aria-checked'), 'the switch shows the tunnel the whole browser is on').toBe('true')
  expect(await popover.locator('.tunnel-row[data-tunnel="socks5"] .tunnel-label').textContent()).toBe(TUNNEL_NAME)
  await shoot(app, chrome, popover, 'tunnel-everywhere-popover')
  await popover.click('#tunnel-tab-first')
  expect(await popover.locator('#tunnel-switch-socks5').getAttribute('aria-checked'), 'the site\'s own panel shows the default it follows').toBe('true')
  await closePopover()
}, 4 * QA_TEST_TIMEOUT_MS)

it('[app:tunnel-everywhere-leaves-a-site-set-to-off-direct] a site set to off moves to the direct profile and arrives direct, from its own storage', async () => {
  await open(offUrl(), 'tunnelled')
  expect(await cookies(undefined, OFF)).toEqual(['who=tunnel'])
  const tunnelled = asked(OFF, hosts.offDecoy.port)

  const popover = await openPopover()
  // The popup opens on Browser-wide for a site that follows the browser: the site's own switch is on the first panel.
  await popover.click('#tunnel-tab-first')
  await popover.click('#tunnel-switch-socks5')
  await popover.waitForSelector('.tunnel-notice')
  expect(await popover.locator('.tunnel-notice-text').textContent()).toBe(DIRECT_NOTICE)
  await shoot(app, chrome, popover, 'tunnel-everywhere-direct-notice')
  await popover.click('#tunnel-notice-confirm')
  expect(await waitFor(async () => await tabTitle() === 'direct', 20_000)).toBe(true)

  expect(asked(OFF, hosts.offDecoy.port), 'the page did not come through the tunnel again').toBe(tunnelled)
  expect(hosts.offDecoy.hits, 'it came from the site itself').toBeGreaterThan(0)
  expect(await sessionOfTab(offUrl()), 'in a session of its own, with WebRTC as the browser has it').toMatchObject({ isDefault: false, webrtc: 'default' })
  expect(await cookies('direct-profile-memory', OFF), 'its cookie is in the direct profile').toEqual(['who=direct-profile'])
  expect(await cookies(undefined, OFF), 'the shared session keeps what it had').toEqual(['who=tunnel'])
  expect(await waitFor(async () => await chrome.getAttribute('#tunnel-btn', 'data-tunnel') === null), 'the tunnel button is not purple').toBe(true)

  // The row sent the tab direct; "Always use for this site" keeps that for the site, which the tests below rely on. It moves nothing.
  const hitsBefore = hosts.offDecoy.hits
  await pressAlways(app, chrome, 'socks5')
  await closeTunnelList(app, chrome)
  await delay(500)
  expect(hosts.offDecoy.hits, 'saving the choice did not load the page again').toBe(hitsBefore)
  expect(await tabTitle()).toBe('direct')
  expect(await sessionOfTab(offUrl()), 'and did not move it').toMatchObject({ isDefault: false, webrtc: 'default' })

  // The row gave this tab the choice to go direct, and every site opened in it goes direct in the direct profile: the tests below
  // open sites that follow the browser, so they open them in a tab that has no choice.
  const tabCount = (await tabIds(chrome)).length
  await chrome.click('#new-tab')
  expect(await waitFor(async () => (await tabIds(chrome)).length === tabCount + 1), 'a new tab, which has no choice of its own').toBe(true)
}, 4 * QA_TEST_TIMEOUT_MS)

it('[app:tunnel-everywhere-leaves-a-site-set-to-off-direct] Settings lists the site under the direct profile, and the toggle is on', async () => {
  const settings = await openSettingsPrivacy()
  await settings.waitForSelector('#row-route-everywhere')
  expect(await settings.locator('#row-route-everywhere input[type=checkbox]').isChecked()).toBe(true)
  const heading = settings.locator('#row-route-sites .tunnel-list-group')
  expect(await heading.allTextContents()).toEqual(['Direct profile'])
  expect(await settings.locator('#row-route-sites .tunnel-list-origin').textContent()).toBe(origin(OFF, hosts.offDecoy.port))
  await settings.locator('#row-route-everywhere').scrollIntoViewIfNeeded()
  await shoot(app, chrome, settings, 'tunnel-everywhere-settings')
  await settings.close()
}, 3 * QA_TEST_TIMEOUT_MS)

it('[app:tunnel-everywhere-moves-no-website] turning the setting off sends the plain website direct without moving it, and the site set to off stays where it is', async () => {
  const settings = await openSettingsPrivacy()
  await settings.waitForSelector('#row-route-everywhere input[type=checkbox]')
  await settings.locator('#row-route-everywhere input[type=checkbox]').click()
  expect(await waitFor(async () => await app.evaluate(({ session }) => session.defaultSession.resolveProxy('http://example.com/').then((proxy) => proxy === 'DIRECT')))).toBe(true)
  await settings.close()

  await chrome.bringToFront().catch(() => {})
  await open(plainUrl(), 'direct')
  expect(hosts.plainDecoy.hits, 'with the setting off the website is asked for directly').toBeGreaterThan(0)
  expect(await cookies(undefined, PLAIN), 'in the same session as before').toEqual(expect.arrayContaining(['who=shared']))
  expect(await sessionOfTab(plainUrl())).toMatchObject({ isDefault: true, webrtc: 'default' })

  await open(offUrl(), 'direct')
  expect(await sessionOfTab(offUrl()), 'the site set to off did not move').toMatchObject({ isDefault: false })
  expect(await cookies('direct-profile-memory', OFF)).toEqual(['who=direct-profile'])

  // And on again: the plain website goes back through the tunnel with no move.
  const again = await openSettingsPrivacy()
  await again.waitForSelector('#row-route-everywhere input[type=checkbox]')
  await again.locator('#row-route-everywhere input[type=checkbox]').click()
  expect(await waitFor(async () => await app.evaluate(({ session }) => session.defaultSession.resolveProxy('http://example.com/').then((proxy) => proxy.startsWith('PROXY 127.0.0.1:'))))).toBe(true)
  await again.close()
}, 5 * QA_TEST_TIMEOUT_MS)

it('[app:tunnel-everywhere-sends-nothing-direct] with the tunnel stopped, a website with no setting fails and nothing arrives direct', async () => {
  await open(plainUrl(), 'tunnelled')
  const hits = hosts.plainDecoy.hits + hosts.plainReal.hits + hosts.cdnDecoy.hits + hosts.wsDecoy.hits
  await socks.close()
  await app.evaluate(({ webContents }, url) => { webContents.getAllWebContents().find((wc) => wc.getURL() === url)?.reloadIgnoringCache() }, plainUrl())
  await delay(3000)
  expect(hosts.plainDecoy.hits + hosts.plainReal.hits + hosts.cdnDecoy.hits + hosts.wsDecoy.hits, 'nothing arrived anywhere').toBe(hits)
  expect(await tabTitle(), 'the page did not load').not.toBe('tunnelled')
  expect(await tabTitle()).not.toBe('direct')
}, 3 * QA_TEST_TIMEOUT_MS)
