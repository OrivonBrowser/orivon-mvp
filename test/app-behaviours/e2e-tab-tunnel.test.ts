// A tab that carries a tunnel choice sends the first request of everything it opens through that tunnel, never from the
// session the website would have had with no choice. The choice is set on the tab through the test seam, before the tab
// navigates, and then every way a tab reaches a website is tried: a typed address, a tile of the new-tab page, a link, a
// script's navigation, a redirect, a sized and a featureless `window.open`, a middle-click into a new tab, Back and Forward
// across a page outside the profile, and the wake of a tab that was asleep when it was given the choice. Every name has a decoy on the same port on loopback
// (the host resolver maps the fixture's names there), so a request that skipped the tunnel lands on the decoy and counts a
// hit. The last case runs with the whole browser on the tunnel: a direct tab reaches the website outside it, and keeps the
// tunnel a website has of its own.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-tab-tunnel.test.ts
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { startSocks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import type { Socks5Fixture } from '../../src/broker/route/tests/socks5-fixture.test-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { activeTabInfo, delay, findViewShowing, tabIds, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

const A = 'plain.socks.test'
const B = 'other.socks.test'
const MIN = 60_000
type Choice = 'nym' | 'socks5' | 'direct'

interface Hosted { port: number, hits: number, close: () => Promise<void> }

async function host (answer: (request: IncomingMessage, response: ServerResponse) => void): Promise<Hosted> {
  const hosted: Hosted = { port: 0, hits: 0, close: async () => {} }
  const server = createServer((request, response) => { hosted.hits += 1; answer(request, response) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  hosted.port = (server.address() as AddressInfo).port
  hosted.close = async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }) }
  return hosted
}

let socks: Socks5Fixture
const hosts: Record<'decoy' | 'real' | 'local', Hosted> = {} as never
const cleanups: Array<() => Promise<void> | void> = []

const urlA = (path = '/'): string => `http://${A}:${String(hosts.decoy.port)}${path}`
const urlB = (): string => `http://${B}:${String(hosts.decoy.port)}/`
const urlLocal = (): string => `http://127.0.0.1:${String(hosts.local.port)}/`
const asked = (name: string): number => socks.requests.filter((request) => request.destination === name && request.port === hosts.decoy.port).length

/** What a page that leaves offers: a link, a script navigation, a redirect, a sized and a featureless popup, and a link to open in a new tab. */
const leaving = (title: string): string => `<!doctype html><title>${title}</title><body>
<a id="go" href="${urlB()}">link</a><a id="redirect" href="${urlA('/redirect')}">redirect</a><a id="new" href="${urlB()}">new tab</a>
<button id="script">script</button><button id="sized">sized</button><button id="bare">bare</button>
<script>
document.getElementById('script').addEventListener('click', () => { location.assign('${urlB()}') })
document.getElementById('sized').addEventListener('click', () => { window.open('${urlB()}', 'sized', 'width=400,height=300') })
document.getElementById('bare').addEventListener('click', () => { window.open('${urlB()}', 'bare') })
</script></body>`

beforeAll(async () => {
  hosts.decoy = await host((_request, response) => { response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }).end('<!doctype html><title>direct</title><body>direct</body>') })
  hosts.real = await host((request, response) => {
    const name = (request.headers.host ?? '').split(':')[0]
    if (request.url === '/redirect') { response.writeHead(302, { location: urlB(), 'cache-control': 'no-store' }).end(); return }
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }).end(leaving(name === B ? 'tunnelled-b' : 'tunnelled'))
  })
  hosts.local = await host((_request, response) => { response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }).end('<!doctype html><title>local</title><body>local</body>') })
  const target = { host: '127.0.0.1', port: hosts.real.port }
  socks = await startSocks5Fixture({ preferAuth: true, names: { [`${A}:${String(hosts.decoy.port)}`]: target, [`${B}:${String(hosts.decoy.port)}`]: target } })
  cleanups.push(...Object.values(hosts).map((one) => () => one.close()), async () => { await socks.close() })
}, 60_000)

afterAll(async () => {
  for (const cleanup of cleanups) await cleanup()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface Seed { settings?: Record<string, unknown>, routes?: object, bookmarks?: object }

async function start (seed: Seed = {}): Promise<{ app: ElectronApplication, chrome: Page }> {
  return await launchShell({
    args: [`--host-resolver-rules=MAP ${A} 127.0.0.1, MAP ${B} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`],
    seedProfile: async (userDataDir) => {
      writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, values: { 'network.route.proxy': `127.0.0.1:${String(socks.port)}`, ...seed.settings } }))
      if (seed.routes !== undefined) writeFileSync(join(userDataDir, 'routes.json'), JSON.stringify(seed.routes))
      if (seed.bookmarks !== undefined) writeFileSync(join(userDataDir, 'bookmarks.json'), JSON.stringify(seed.bookmarks))
    }
  })
}

const activeId = async (chrome: Page): Promise<string> => (await activeTabInfo(chrome)).activeId as string
const tabTitle = async (chrome: Page): Promise<string> => (await activeTabInfo(chrome)).title as string

/** Gives the tab the choice through the test seam, the way the tunnel button will, and checks the seam found the tab. */
async function giveChoice (app: ElectronApplication, tabId: string, choice: Choice): Promise<void> {
  const done = await app.evaluate((_electron, [id, value]) => (globalThis as unknown as { __orivonDevTabTunnel?: { set: (tab: string, choice: string | null) => boolean } }).__orivonDevTabTunnel?.set(id as string, value as string), [tabId, choice])
  expect(done, 'the test seam found the tab').toBe(true)
}

/** Types `url` into the address bar and waits for the page titled `title` to show. */
async function open (app: ElectronApplication, chrome: Page, url: string, title: string): Promise<Page> {
  await clickAddressBarRetrying(chrome, url)
  expect((await waitForTab(chrome, { address: url, title })).ok, `${url} shows "${title}"`).toBe(true)
  expect(await waitFor(() => findViewShowing(app, chrome, url) !== undefined)).toBe(true)
  const page = findViewShowing(app, chrome, url) as Page
  await page.waitForLoadState('load')
  return page
}

/**
 * Closes every tab but `keep` and waits until `keep` is alone and in front. A popup or a tab the page opened takes the front
 * and shows an address of its own; with it left open, the address typed next would go into it, and the page found for that
 * address could be the opener's, which a hidden view cannot paint or be clicked.
 */
async function onlyTab (chrome: Page, keep: string): Promise<void> {
  for (const id of await tabIds(chrome)) {
    if (id !== keep) await chrome.evaluate((tab) => { (window as unknown as { orivonShell: { closeTab: (id: string) => void } }).orivonShell.closeTab(tab) }, id)
  }
  expect(await waitFor(async () => (await tabIds(chrome)).length === 1 && await activeId(chrome) === keep), 'the opener is the only tab and in front').toBe(true)
}

/** Waits for `name` to be asked of the tunnel more than `before` times, then checks nothing reached the decoy since `directBefore`. */
async function viaTunnel (name: string, before: number, directBefore: number, what: string): Promise<void> {
  expect(await waitFor(() => asked(name) > before, 30_000), `${what}: ${name} was asked of the tunnel`).toBe(true)
  await delay(1000)
  expect(hosts.decoy.hits - directBefore, `${what}: the first request never reached the website directly`).toBe(0)
}

/** Presses `selector` in `page` and checks the website `name` it leads to is reached through the tunnel. */
async function leaveBy (page: Page, selector: string, name: string, what: string, directBefore: number, options: { button?: 'middle' } = {}): Promise<void> {
  const before = asked(name)
  await page.click(selector, options)
  await viaTunnel(name, before, directBefore, what)
}

it('[app:tab-tunnel-first-request-leaves-through-the-tunnel] a typed address, a link, a script, a redirect, a sized and a featureless popup and a middle-click from a tab set to a tunnel reach the website through it, never direct', async () => {
  const { app, chrome } = await start()
  try {
    const directBefore = hosts.decoy.hits
    const first = await activeId(chrome)
    await giveChoice(app, first, 'socks5')

    const asking = asked(A)
    let page = await open(app, chrome, urlA(), 'tunnelled')
    await viaTunnel(A, asking, directBefore, 'a typed address on the new-tab page')
    expect(await app.evaluate(({ webContents, session }, url) => webContents.getAllWebContents().find((wc) => wc.getURL() === url)?.session === session.defaultSession, urlA()), 'the page lives in the tunnel\'s profile, not the shared session').toBe(false)

    await leaveBy(page, '#go', B, 'a link', directBefore)
    expect(await waitFor(async () => await tabTitle(chrome) === 'tunnelled-b', 30_000)).toBe(true)

    page = await open(app, chrome, urlA(), 'tunnelled')
    await leaveBy(page, '#script', B, 'a script\'s navigation', directBefore)
    expect(await waitFor(async () => await tabTitle(chrome) === 'tunnelled-b', 30_000)).toBe(true)

    page = await open(app, chrome, urlA(), 'tunnelled')
    await leaveBy(page, '#redirect', B, 'a redirect', directBefore)
    expect(await waitFor(async () => await tabTitle(chrome) === 'tunnelled-b', 30_000)).toBe(true)

    page = await open(app, chrome, urlA(), 'tunnelled')
    await leaveBy(page, '#sized', B, 'a sized window.open', directBefore)
    await onlyTab(chrome, first)

    page = await open(app, chrome, urlA(), 'tunnelled')
    await leaveBy(page, '#bare', B, 'a featureless window.open', directBefore)
    await onlyTab(chrome, first)

    page = await open(app, chrome, urlA(), 'tunnelled')
    const tabs = (await tabIds(chrome)).length
    await leaveBy(page, '#new', B, 'a middle-click into a new tab', directBefore, { button: 'middle' })
    expect(await waitFor(async () => (await tabIds(chrome)).length > tabs)).toBe(true)

    // The control: a tab with no choice reaches the same website directly, so the decoy does answer when the tunnel is skipped.
    const decoyBefore = hosts.decoy.hits
    await chrome.click('#new-tab')
    await open(app, chrome, urlA(), 'direct')
    expect(hosts.decoy.hits - decoyBefore, 'a tab with no choice reaches the website directly').toBeGreaterThan(0)
  } finally {
    await closeElectron(app)
  }
}, 8 * QA_TEST_TIMEOUT_MS)

it('[app:tab-tunnel-new-tab-tile-first-request-leaves-through-the-tunnel] a tile of the new-tab page opened in a tab set to a tunnel reaches the website through it, never direct', async () => {
  const bookmarks = { version: 2, roots: { bar: [{ id: 'plain000001', kind: 'url', title: 'Plain', url: urlA(), added: 1 }], other: [], reading: [] } }
  const { app, chrome } = await start({ bookmarks })
  try {
    const directBefore = hosts.decoy.hits
    const dashboard = (): Page | undefined => app.windows().find((w) => w.url().includes('/newtab/'))
    expect(await waitFor(() => dashboard() !== undefined)).toBe(true)
    expect(await waitFor(async () => await (dashboard() as Page).locator('#bookmarks-grid .tile').count() === 1)).toBe(true)
    await giveChoice(app, await activeId(chrome), 'socks5')

    const before = asked(A)
    await (dashboard() as Page).locator('#bookmarks-grid .tile').first().click()
    expect((await waitForTab(chrome, { address: urlA(), title: 'tunnelled' })).ok).toBe(true)
    await viaTunnel(A, before, directBefore, 'a tile of the new-tab page')
  } finally {
    await closeElectron(app)
  }
}, 4 * QA_TEST_TIMEOUT_MS)

it('[app:tab-tunnel-back-forward-first-request-leaves-through-the-tunnel] Back to a page outside the profile and Forward onto the website reach it through the tunnel again, never direct', async () => {
  const { app, chrome } = await start()
  try {
    const directBefore = hosts.decoy.hits
    await open(app, chrome, urlLocal(), 'local')
    await giveChoice(app, await activeId(chrome), 'socks5')

    const first = asked(A)
    await open(app, chrome, urlA(), 'tunnelled')
    await viaTunnel(A, first, directBefore, 'the address typed after the choice')

    await chrome.click('#back')
    expect((await waitForTab(chrome, { address: urlLocal(), title: 'local' })).ok).toBe(true)

    const again = asked(A)
    await chrome.click('#forward')
    expect((await waitForTab(chrome, { address: urlA(), title: 'tunnelled' })).ok).toBe(true)
    await viaTunnel(A, again, directBefore, 'Forward')
  } finally {
    await closeElectron(app)
  }
}, 4 * QA_TEST_TIMEOUT_MS)

it('[app:tab-tunnel-wake-first-request-leaves-through-the-tunnel] a sleeping tab given a tunnel choice loads its page through the tunnel when it wakes, never direct', async () => {
  // A tab that already shows a website in a tunnel's profile does not sleep (a session other than the shared one keeps a tab awake),
  // so the wake that matters is the one of a tab asleep in the shared session when the choice is set.
  const { app, chrome } = await start({ settings: { 'performance.sleepAfter': '15m' } })
  try {
    await app.evaluate(() => { (globalThis as unknown as { __orivonSleepIgnoreCapture: boolean }).__orivonSleepIgnoreCapture = true })
    const sleeper = await activeId(chrome)
    await open(app, chrome, urlA(), 'direct')

    await chrome.click('#new-tab')
    expect(await waitFor(async () => await activeId(chrome) !== sleeper)).toBe(true)
    const slept = await app.evaluate(async (_electron, stamps) => await (globalThis as unknown as { __orivonSweepNow: (ago: Record<string, number>) => Promise<string[]> }).__orivonSweepNow(stamps), { [sleeper]: 16 * MIN })
    expect(slept).toEqual([sleeper])
    const tab = chrome.locator(`.tab[data-id="${sleeper}"]`)
    expect(await waitFor(async () => (await tab.getAttribute('class'))?.split(' ').includes('sleeping') === true)).toBe(true)

    await giveChoice(app, sleeper, 'socks5')
    const directBefore = hosts.decoy.hits
    const before = asked(A)
    await tab.click()
    expect(await waitFor(async () => await activeId(chrome) === sleeper && (await tab.getAttribute('class'))?.split(' ').includes('sleeping') !== true)).toBe(true)
    expect((await waitForTab(chrome, { address: urlA(), title: 'tunnelled' })).ok).toBe(true)
    await viaTunnel(A, before, directBefore, 'the wake')
  } finally {
    await closeElectron(app)
  }
}, 4 * QA_TEST_TIMEOUT_MS)

it('[app:tab-tunnel-direct-tab-keeps-a-sites-own-tunnel] with the whole browser on the tunnel, a tab set to direct reaches a website outside it, and a website with a tunnel of its own keeps that tunnel there', async () => {
  const siteB = `http://${B}:${String(hosts.decoy.port)}`
  const routes = { version: 1, profiles: 1, kinds: 1, origins: [siteB], via: { [siteB]: 'socks5' }, off: [], apart: [], apartProxy: [siteB], apartDirect: [] }
  const { app, chrome } = await start({ settings: { 'network.tunnel.everywhere': true }, routes })
  try {
    await giveChoice(app, await activeId(chrome), 'direct')

    const tunnelledA = asked(A)
    const decoyBefore = hosts.decoy.hits
    await open(app, chrome, urlA(), 'direct')
    expect(hosts.decoy.hits - decoyBefore, 'a direct tab reaches the website outside the tunnel').toBeGreaterThan(0)
    expect(asked(A) - tunnelledA, 'and the tunnel was not asked for it').toBe(0)

    const directBefore = hosts.decoy.hits
    const before = asked(B)
    await open(app, chrome, urlB(), 'tunnelled-b')
    await viaTunnel(B, before, directBefore, 'a website with a tunnel of its own, in a direct tab')

    // The control: a tab with no choice goes through the tunnel the whole browser is on.
    const control = asked(A)
    await chrome.click('#new-tab')
    await open(app, chrome, urlA(), 'tunnelled')
    expect(asked(A) - control, 'a tab with no choice follows the whole browser onto the tunnel').toBeGreaterThan(0)
  } finally {
    await closeElectron(app)
  }
}, 4 * QA_TEST_TIMEOUT_MS)
