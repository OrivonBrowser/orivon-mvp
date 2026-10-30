// A plain website the person turns the tunnel on for runs in the tunnel profile: the popover tells them first, then
// the page and a subresource from another host arrive through the SOCKS5 fixture, its cookie lives apart from the shared
// session's, and turning the tunnel off again returns the tab to the shared session with that cookie untouched. A row sets
// the tab; "Always use for this site" is what makes the tunnel the website's own, which Settings then lists. The
// fixture names resolve (on loopback) in the browser to a decoy on the same port as the fixture's names, so a request
// that went direct would show the decoy's page and count a hit.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-website-tunnel.test.ts
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
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { shoot } from '../support/auth-support.js'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { activeTabInfo, delay, waitFor, waitForTab } from '../support/smoke-helpers.mjs'
import { closeTunnelList, pressAlways } from '../support/tunnel-popup.js'

const SITE_NAME = 'site.socks.test'
const CDN_NAME = 'cdn.socks.test'
const NOTICE = 'This site moves to your tunnel profile. You\'ll sign in to it again once, and what it stores stays apart from your normal browsing.'
const TUNNEL_NAME = 'Your proxy'

interface Hosted { port: number, hits: number, close: () => Promise<void> }

async function host (answer: (request: IncomingMessage, response: ServerResponse) => void, port = 0): Promise<Hosted> {
  const hosted: Hosted = { port: 0, hits: 0, close: async () => {} }
  const server = createServer((request, response) => { hosted.hits += 1; answer(request, response) })
  await new Promise<void>((resolve) => { server.listen(port, '127.0.0.1', resolve) })
  hosted.port = (server.address() as AddressInfo).port
  hosted.close = async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }) }
  return hosted
}

const page = (title: string, cookie: string, image: string) => (_request: IncomingMessage, response: ServerResponse): void => {
  response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `who=${cookie}; Path=/` })
  response.end(`<!doctype html><title>${title}</title><body>${title}<img id="pic" src="${image}"></body>`)
}
const pixel = (_request: IncomingMessage, response: ServerResponse): void => {
  response.writeHead(200, { 'content-type': 'image/png' })
  response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
}

let dir: string
let socks: Socks5Fixture
let app: ElectronApplication
let chrome: Page
let decoy: Hosted
let real: Hosted
let cdnDecoy: Hosted
let cdnReal: Hosted
const cleanups: Array<() => Promise<void> | void> = []

const siteUrl = (): string => `http://${SITE_NAME}:${String(decoy.port)}/`
const siteOrigin = (): string => `http://${SITE_NAME}:${String(decoy.port)}`
// The fixture site is plain http, which may not be written to disk, so its profile is the in-memory one.
const profilePartition = 'proxy-profile-memory'
const asked = (name: string, port: number): number => socks.requests.filter((request) => request.destination === name && request.port === port).length
const findPopup = (): Page | undefined => app.windows().find((w) => w.url().includes('/site-info/') && !w.isClosed())

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-website-tunnel-e2e-'))
  cdnDecoy = await host(pixel)
  cdnReal = await host(pixel)
  decoy = await host(page('direct', 'shared', `http://${CDN_NAME}:${String(cdnDecoy.port)}/pic.png`))
  real = await host(page('tunnelled', 'site', `http://${CDN_NAME}:${String(cdnDecoy.port)}/pic.png`))
  socks = await startSocks5Fixture({
    preferAuth: true,
    names: {
      [`${SITE_NAME}:${String(decoy.port)}`]: { host: '127.0.0.1', port: real.port },
      [`${CDN_NAME}:${String(cdnDecoy.port)}`]: { host: '127.0.0.1', port: cdnReal.port }
    }
  })
  cleanups.push(() => decoy.close(), () => real.close(), () => cdnDecoy.close(), () => cdnReal.close(), async () => { await socks.close() }, () => { rmSync(dir, { recursive: true, force: true }) })

  const launched = await launchShell({
    args: [`--host-resolver-rules=MAP ${SITE_NAME} 127.0.0.1, MAP ${CDN_NAME} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`],
    seedProfile: async (userDataDir) => {
      writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}` } }))
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

async function openSite (title: string): Promise<void> {
  await clickAddressBarRetrying(chrome, siteUrl())
  expect((await waitForTab(chrome, { address: siteUrl(), title })).ok).toBe(true)
}

async function tabTitle (): Promise<string> {
  return (await activeTabInfo(chrome)).title
}

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

/** Cookies of the shared session and of the site's own, by name, for the site's host. */
async function cookies (partition: string | undefined): Promise<string[]> {
  return await app.evaluate(async ({ session }, args) => {
    const where = args.partition === undefined ? session.defaultSession : session.fromPartition(args.partition)
    return (await where.cookies.get({ domain: args.domain })).map((cookie) => `${cookie.name}=${cookie.value}`)
  }, { partition, domain: SITE_NAME })
}

const sessionOfTab = async (address: string): Promise<{ isDefault: boolean, webrtc: string } | null> => await app.evaluate(({ webContents, session }, url) => {
  const contents = webContents.getAllWebContents().find((wc) => wc.getURL() === url)
  return contents === undefined ? null : { isDefault: contents.session === session.defaultSession, webrtc: contents.getWebRTCIPHandlingPolicy() }
}, address)

it('[app:tunnelled-website-gets-its-own-storage] a website in the shared session has no tunnel, and the popover offers the switch', async () => {
  await openSite('direct')
  expect(await sessionOfTab(siteUrl())).toMatchObject({ isDefault: true })
  expect(await cookies(undefined)).toEqual(['who=shared'])
  expect(await chrome.getAttribute('#tunnel-btn', 'data-tunnel'), 'the tunnel button is not purple').toBeNull()

  const popover = await openPopover()
  expect(await popover.locator('.tunnel-row[data-tunnel="socks5"] .tunnel-label').textContent()).toBe(TUNNEL_NAME)
  expect(await popover.locator('#tunnel-switch-socks5').getAttribute('aria-checked')).toBe('false')
  expect(await popover.locator('.tunnel-notice').count()).toBe(0)
  await closePopover()
}, 3 * QA_TEST_TIMEOUT_MS)

it('[app:tunnelled-website-gets-its-own-storage] the notice comes first, Cancel changes nothing, and Confirm moves the site into the tunnel profile', async () => {
  const popover = await openPopover()
  await popover.click('#tunnel-switch-socks5')
  await popover.waitForSelector('.tunnel-notice')
  expect(await popover.locator('.tunnel-notice-text').textContent()).toBe(NOTICE)
  expect(await popover.locator('#tunnel-notice-confirm').textContent()).toBe('Confirm')
  await shoot(app, chrome, popover, 'website-tunnel-notice')

  await popover.click('#tunnel-notice-cancel')
  await popover.waitForSelector('.tunnel-notice', { state: 'detached' })
  expect(await popover.locator('#tunnel-switch-socks5').getAttribute('aria-checked')).toBe('false')
  await delay(500)
  expect(await tabTitle(), 'Cancel leaves the tab as it was').toBe('direct')
  expect(socks.requests.length, 'and the tunnel saw nothing').toBe(0)

  const before = decoy.hits
  const cdnBefore = cdnDecoy.hits
  await popover.click('#tunnel-switch-socks5')
  await popover.waitForSelector('.tunnel-notice')
  await popover.click('#tunnel-notice-confirm')
  expect(await waitFor(async () => await tabTitle() === 'tunnelled', 20_000)).toBe(true)
  expect(decoy.hits, 'the tab moved without asking the site directly again').toBe(before)

  expect(await sessionOfTab(siteUrl())).toEqual({ isDefault: false, webrtc: 'disable_non_proxied_udp' })
  expect(asked(SITE_NAME, decoy.port), 'the page came through the tunnel').toBeGreaterThan(0)
  expect(await waitFor(() => asked(CDN_NAME, cdnDecoy.port) > 0), 'and so did its image from another host').toBe(true)
  expect(cdnDecoy.hits, 'which never went direct').toBe(cdnBefore)
  expect(socks.requests.find((request) => request.destination === SITE_NAME)?.userId, 'it signed in to the tunnel with the credentials the tunnel profile shares').toBeDefined()

  expect(await cookies(profilePartition), 'its cookie lives in the tunnel profile').toEqual(['who=site'])
  expect(await cookies(undefined), 'the shared session\'s cookie is untouched').toEqual(['who=shared'])
}, 4 * QA_TEST_TIMEOUT_MS)

it('[app:tunnelled-website-gets-its-own-storage] the tunnel button and its popover say the tab goes through the tunnel, and the switch is on', async () => {
  expect(await waitFor(async () => await chrome.getAttribute('#tunnel-btn', 'data-tunnel') === 'on')).toBe(true)
  const popover = await openPopover()
  expect(await popover.locator('#tunnel-switch-socks5').getAttribute('aria-checked')).toBe('true')
  expect(await popover.locator('.tunnel-row[data-tunnel="socks5"] .tunnel-state').textContent()).toBe('This tab\'s traffic goes through your tunnel.')
  expect(await popover.locator('#tunnel-switch-always').getAttribute('aria-checked'), 'the row set the tab: the site has no tunnel of its own yet').toBe('false')
  await shoot(app, chrome, popover, 'website-tunnel-on')
  await closePopover()
  await shoot(app, chrome, chrome, 'website-tunnel-key')
}, 3 * QA_TEST_TIMEOUT_MS)

it('[app:tunnelled-website-gets-its-own-storage] Settings lists the site, and removing its separate storage clears that site\'s data in the profile and nothing else', async () => {
  // The row moved the tab only; the site is listed once "Always use for this site" has made the tunnel its own.
  await pressAlways(app, chrome, 'socks5')
  await closeTunnelList(app, chrome)
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/tunnels') })
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
  const settings = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
  await settings.waitForSelector('#row-route-sites .tunnel-list-row')
  const row = settings.locator('#row-route-sites .tunnel-list-row')
  expect(await row.locator('.tunnel-list-origin').textContent()).toBe(siteOrigin())
  expect(await row.locator('.muted').textContent()).toBe('Through your proxy: this site\'s traffic goes through it. It lives in your proxy profile.')
  await row.scrollIntoViewIfNeeded()
  await shoot(app, chrome, settings, 'website-tunnel-settings')

  await row.locator('button', { hasText: 'Remove its separate storage' }).click()
  expect(await waitFor(async () => (await cookies(profilePartition)).length === 0)).toBe(true)
  expect(await cookies(undefined), 'the shared session keeps its cookie').toEqual(['who=shared'])
  expect(await settings.locator('#row-route-sites .tunnel-list-row').count(), 'the site still has its setting').toBe(1)
  await settings.close()
}, 3 * QA_TEST_TIMEOUT_MS)

it('[app:tunnelled-website-gets-its-own-storage] turning the tunnel off returns the tab to the shared session with no new notice, and the site\'s storage stays', async () => {
  // The site wrote a cookie again after its storage was cleared; it is kept when the tunnel goes off.
  await app.evaluate(async ({ session }, args) => {
    await session.fromPartition(args.partition).cookies.set({ url: args.url, name: 'kept', value: '1' })
  }, { partition: profilePartition, url: siteUrl() })

  // The tab moves to another view, which closes the popover: it is opened again for each press.
  const off = await openPopover()
  await off.click('#tunnel-switch-socks5')
  expect(await waitFor(async () => await tabTitle() === 'direct', 20_000)).toBe(true)
  expect(await sessionOfTab(siteUrl())).toMatchObject({ isDefault: true })
  expect(decoy.hits, 'the page came from the site itself again').toBeGreaterThan(0)
  expect(await cookies(undefined), 'the shared session\'s cookie is as it was').toEqual(['who=shared'])
  expect(await cookies(profilePartition), 'the site\'s own storage is kept').toEqual(['kept=1'])
  expect(await waitFor(async () => await chrome.getAttribute('#tunnel-btn', 'data-tunnel') === null)).toBe(true)
  await delay(500)
  if (findPopup() !== undefined) await closePopover()

  // Turned on again, the site is already apart: the switch takes at once, with no notice, and the storage it kept is there.
  const on = await openPopover()
  await on.click('#tunnel-switch-socks5')
  expect(await waitFor(async () => await tabTitle() === 'tunnelled', 20_000), 'no notice stood in the way').toBe(true)
  expect(await sessionOfTab(siteUrl())).toMatchObject({ isDefault: false })
  expect((await cookies(profilePartition)).sort()).toEqual(['kept=1', 'who=site'])

  // The tests below are about a site with a tunnel of its own, so it keeps this one for good.
  await pressAlways(app, chrome, 'socks5')
  await closeTunnelList(app, chrome)
}, 4 * QA_TEST_TIMEOUT_MS)

it('[app:tunnelled-website-sends-nothing-direct] a load the shell did not move, into the shared session, is refused and reaches neither the site nor the tunnel', async () => {
  // Another site in the shared session, then a script of the main process loads the tunnelled site in that same view, as a waking tab or a history step would.
  const elsewhere = `http://127.0.0.1:${String(cdnReal.port)}/`
  await clickAddressBarRetrying(chrome, elsewhere)
  expect(await waitFor(async () => (await activeTabInfo(chrome)).address === elsewhere)).toBe(true)
  await delay(500)
  const direct = decoy.hits + real.hits
  const tunnelled = socks.requests.length
  await app.evaluate(({ webContents }, args) => {
    const view = webContents.getAllWebContents().find((wc) => wc.getURL() === args.elsewhere)
    void view?.loadURL(args.site).catch(() => {})
  }, { elsewhere, site: siteUrl() })
  await delay(2500)
  expect(decoy.hits + real.hits, 'nothing reached the site directly').toBe(direct)
  expect(socks.requests.length, 'and the refused load did not borrow the tunnel').toBe(tunnelled)
  expect(['direct', 'tunnelled'], 'the site did not load in the shared session').not.toContain(await tabTitle())
}, 3 * QA_TEST_TIMEOUT_MS)

it('[app:tunnelled-website-sends-nothing-direct] with the tunnel stopped, the website fails and nothing reaches the site directly', async () => {
  const hits = decoy.hits + real.hits
  const cdnHits = cdnDecoy.hits
  await socks.close()
  await app.evaluate(({ webContents }, url) => { webContents.getAllWebContents().find((wc) => wc.getURL() === url)?.reloadIgnoringCache() }, siteUrl())
  await delay(3000)
  expect(decoy.hits + real.hits, 'nothing arrived at the site').toBe(hits)
  expect(cdnDecoy.hits).toBe(cdnHits)
  expect(await tabTitle(), 'the page did not load').not.toBe('direct')
  expect(await tabTitle()).not.toBe('tunnelled')
}, 3 * QA_TEST_TIMEOUT_MS)
