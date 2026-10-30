// The tunnels button on the new tab, driven with the real button and the real list it opens. A person picks a tunnel for the
// tab before typing the first address, and that address (and every site the tab opens after it) goes through it: the website
// has a decoy on the same name and port that a request which skipped the tunnel would reach. The button turns purple on the new
// tab, opens the same list for the tab on a website of that tab, and turning the lit switch off sends the tab direct again.
// With the whole browser on the tunnel a new tab follows it, and turning its switch off sends only that tab direct. The Nym
// module is the stand-in `e2e-tunnel-button` uses.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-tab-tunnel-button.test.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { EMPTY_WASM, FAKE_NYM_MODULE } from './nym-stand-in.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { shoot } from '../support/auth-support.js'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { ABSENCE_SETTLE_MS, activeTabInfo, delay, findViewShowing, tabIds, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

const NAME = 'plain.nym.test'

interface Hosted { port: number, hits: () => number, close: () => Promise<void> }

async function host (title: string): Promise<Hosted> {
  let hits = 0
  const server: Server = createServer((_request, response) => { hits += 1; response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }).end(`<!doctype html><title>${title}</title><body>${title}<button id="blank" onclick="window.open('about:blank')">blank</button><button id="sized" onclick="window.open(this.dataset.target, '', 'width=420,height=320')">sized</button><button id="sizedCut" onclick="const w = window.open(this.dataset.target, '', 'width=420,height=320'); setTimeout(() => { w.opener = null }, 300)">sized, link cut</button><a id="out" target="_blank" href="about:blank">out</a></body>`) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return { port: (server.address() as AddressInfo).port, hits: () => hits, close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }) } }
}

/** A website that takes the request and answers only when released: a tab opened onto it has committed nothing meanwhile. */
interface Held { port: number, requests: () => number, release: () => void, close: () => Promise<void> }

async function holdingHost (): Promise<Held> {
  const waiting: ServerResponse[] = []
  let requests = 0
  const server: Server = createServer((_request, response) => { requests += 1; waiting.push(response) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const release = (): void => { for (const response of waiting.splice(0)) response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }).end('<!doctype html><title>held</title><body>held</body>') }
  return { port: (server.address() as AddressInfo).port, requests: () => requests, release, close: async () => { release(); await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }) } }
}

let dir: string
let decoy: Hosted
let real: Hosted
let held: Held
let nymLog: string
let moduleDir: string
let configFile: string
const cleanups: Array<() => Promise<void> | void> = []
const url = (): string => `http://${NAME}:${String(decoy.port)}/`
const heldUrl = (): string => `http://${NAME}:${String(held.port)}/`
const askedOfNym = (): number => readFileSync(nymLog, 'utf8').split('\n').filter((line) => line.startsWith('tcp ') && line.endsWith(` ${NAME}:${String(decoy.port)}`)).length

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-tab-tunnel-button-e2e-'))
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
  moduleDir = join(dir, 'module')
  mkdirSync(moduleDir)
  writeFileSync(join(moduleDir, 'smolmix_wasm.js'), FAKE_NYM_MODULE)
  writeFileSync(join(moduleDir, 'smolmix_wasm_bg.wasm'), EMPTY_WASM)
  decoy = await host('direct')
  real = await host('tunnelled')
  held = await holdingHost()
  cleanups.push(async () => { await decoy.close(); await real.close(); await held.close() })
  nymLog = join(dir, 'fake.log')
  writeFileSync(nymLog, '')
  configFile = join(dir, 'fake.json')
  writeFileSync(configFile, JSON.stringify({ failStart: false, log: nymLog, targets: { [`${NAME}:${String(decoy.port)}`]: { host: '127.0.0.1', port: real.port }, [`${NAME}:${String(held.port)}`]: { host: '127.0.0.1', port: held.port } } }))
}, 60_000)

afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function start (settings: Record<string, unknown> = {}): Promise<{ app: ElectronApplication, chrome: Page }> {
  return await launchShell({
    env: { ORIVON_TEST_NYM_MODULE: moduleDir, ORIVON_TEST_NYM_FAKE: configFile },
    args: [`--host-resolver-rules=MAP ${NAME} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`],
    seedProfile: async (userDataDir) => { writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, values: settings })) }
  })
}

const findPopup = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().includes('/site-info/') && !w.isClosed())
const attribute = async (chrome: Page, name: string): Promise<string | null> => await chrome.getAttribute('#tunnel-btn', name)
const activeId = async (chrome: Page): Promise<string> => (await activeTabInfo(chrome)).activeId as string

/** Presses the tunnels button and returns the list it opens, once its rows are drawn. */
async function openList (app: ElectronApplication, chrome: Page): Promise<Page> {
  await chrome.click('#tunnel-btn')
  expect(await waitFor(() => findPopup(app) !== undefined)).toBe(true)
  const popover = findPopup(app) as Page
  await popover.waitForSelector('#tunnel-switch-nym')
  return popover
}

async function closeList (app: ElectronApplication, chrome: Page): Promise<void> {
  if (findPopup(app) !== undefined) await chrome.click('#tunnel-btn')
  expect(await waitFor(() => findPopup(app) === undefined)).toBe(true)
  await delay(300)
}

const stateOf = async (popover: Page, kind: 'nym' | 'socks5'): Promise<string> => (await popover.locator(`.tunnel-row[data-tunnel="${kind}"] .tunnel-state`).textContent()) ?? ''
const notesOf = async (popover: Page): Promise<string> => await popover.locator('.tunnel-section .route-line').allTextContents().then((lines) => lines.join(' | '))

it('[app:tab-tunnel-button-first-address-leaves-through-the-chosen-tunnel] a tunnel picked from the button on the new tab carries the first typed address through it, never direct, and the list is about the tab', async () => {
  const { app, chrome } = await start()
  try {
    expect(await chrome.locator('#tunnel-btn').isVisible(), 'the button is on the new tab').toBe(true)
    expect(await attribute(chrome, 'data-tunnel')).toBeNull()
    expect(await attribute(chrome, 'aria-label')).toBe('Tunnels')

    const popover = await openList(app, chrome)
    expect(await popover.locator('.site-origin').textContent()).toBe('Tunnels')
    expect(await popover.locator('#tunnel-tab-first').textContent(), 'the list is about the tab, not a site').toBe('This tab')
    expect(await popover.locator('.site-claim').count(), 'a tab is its own name, with no address under the title').toBe(0)
    expect(await popover.locator('.tunnel-row').count()).toBe(2)
    expect(await popover.locator('#tunnel-switch-nym').getAttribute('aria-label')).toBe('Use Nym for this tab')
    expect(await popover.locator('#tunnel-switch-nym').getAttribute('aria-checked')).toBe('false')
    expect(await popover.locator('#tunnel-switch-socks5').getAttribute('aria-checked')).toBe('false')
    expect(await notesOf(popover)).toContain('Pick a tunnel and every site you open in this tab goes through it')
    await shoot(app, chrome, popover, 'tab-tunnel-button-new-tab-list')

    await popover.click('#tunnel-switch-nym')
    expect(await popover.locator('.tunnel-notice').count(), 'a tab asks no storage question before it takes a tunnel').toBe(0)
    expect(await waitFor(async () => await attribute(chrome, 'data-tunnel') === 'on')).toBe(true)
    expect(await attribute(chrome, 'aria-label')).toBe('Tunnels. Sites you open in this tab go through Nym')
    expect(await waitFor(async () => (await popover.locator('#tunnel-switch-nym').getAttribute('aria-checked')) === 'true')).toBe(true)
    expect(await notesOf(popover)).toContain('Every site you open in this tab goes through Nym, until the tab is closed.')
    expect(await stateOf(popover, 'nym')).toContain('This tab\'s traffic goes through Nym')
    await closeList(app, chrome)
    await shoot(app, chrome, chrome, 'tab-tunnel-button-new-tab-on')

    // Nothing has been typed yet: the first address now leaves through Nym, so the website answers as the real one and the decoy never hears of it.
    const decoyBefore = decoy.hits()
    const before = askedOfNym()
    await clickAddressBarRetrying(chrome, url())
    expect((await waitForTab(chrome, { address: url(), title: 'tunnelled' }, 60_000)).ok, 'the page came through Nym').toBe(true)
    expect(decoy.hits() - decoyBefore, 'the first request never reached the website directly').toBe(0)
    expect(askedOfNym(), 'Nym was asked for the website').toBeGreaterThan(before)

    // On the website the button is the page's own state, and says the choice is the tab's.
    expect(await waitFor(async () => await attribute(chrome, 'data-tunnel') === 'on')).toBe(true)
    expect(await attribute(chrome, 'aria-label')).toBe('Tunnels. This page goes through Nym. Set for this tab')
  } finally {
    await closeElectron(app)
  }
}, 6 * QA_TEST_TIMEOUT_MS)

it('[app:tab-tunnel-button-lists-the-tab-on-a-website-and-turns-off] on a website of a tab that has a tunnel the button opens the list of the tab, turning its switch off sends the tab direct again, and another new tab starts with no choice', async () => {
  const { app, chrome } = await start()
  try {
    // Pick Nym on the new tab, then go to the website.
    let popover = await openList(app, chrome)
    await popover.click('#tunnel-switch-nym')
    expect(await waitFor(async () => await attribute(chrome, 'data-tunnel') === 'on')).toBe(true)
    await closeList(app, chrome)
    await clickAddressBarRetrying(chrome, url())
    expect((await waitForTab(chrome, { address: url(), title: 'tunnelled' }, 60_000)).ok).toBe(true)
    expect(await waitFor(async () => await attribute(chrome, 'data-tunnel') === 'on')).toBe(true)
    const first = await activeId(chrome)

    // The list is the tab's, not the website's: no storage question, and it names the choice.
    popover = await openList(app, chrome)
    expect(await popover.locator('#tunnel-tab-first').textContent()).toBe('This tab')
    expect(await popover.locator('#tunnel-switch-nym').getAttribute('aria-checked')).toBe('true')
    expect(await notesOf(popover)).toContain('Every site you open in this tab goes through Nym')
    expect(await notesOf(popover)).toContain('sign-ins in your tunnel profile')
    await shoot(app, chrome, popover, 'tab-tunnel-button-website-list')

    // Turning the lit switch off sends the tab direct: the page reloads outside Nym, as the decoy.
    const decoyBefore = decoy.hits()
    await popover.click('#tunnel-switch-nym')
    expect((await waitForTab(chrome, { address: url(), title: 'direct' }, 60_000)).ok, 'the page came back outside the tunnel').toBe(true)
    expect(decoy.hits() - decoyBefore, 'and the website answered directly').toBeGreaterThan(0)
    expect(await waitFor(async () => await attribute(chrome, 'data-tunnel') === null)).toBe(true)
    expect(await attribute(chrome, 'aria-label')).toBe('Tunnels')

    // A second new tab starts with no choice: the choice lasts the tab, not the window.
    await chrome.click('#new-tab')
    expect(await waitFor(async () => (await tabIds(chrome)).length === 2 && await activeId(chrome) !== first)).toBe(true)
    expect(await attribute(chrome, 'data-tunnel')).toBeNull()
    expect(await attribute(chrome, 'aria-label')).toBe('Tunnels')
    const fresh = await openList(app, chrome)
    expect(await fresh.locator('#tunnel-switch-nym').getAttribute('aria-checked')).toBe('false')
    await closeList(app, chrome)
  } finally {
    await closeElectron(app)
  }
}, 6 * QA_TEST_TIMEOUT_MS)

it('[app:tab-tunnel-button-direct-for-this-tab-under-a-tunnelled-browser] with the whole browser on the tunnel a new tab follows it, and turning its switch off sends only that tab direct', async () => {
  const { app, chrome } = await start({ 'network.tunnel.everywhere': true })
  try {
    expect(await waitFor(async () => await attribute(chrome, 'data-tunnel') === 'on'), 'the new tab follows the browser onto the tunnel').toBe(true)
    expect(await attribute(chrome, 'aria-label')).toBe('Tunnels. Sites you open in this tab go through Nym')
    const popover = await openList(app, chrome)
    expect(await popover.locator('#tunnel-tab-browser').getAttribute('aria-selected'), 'a tab with no choice of its own opens on the Browser-wide panel while the whole browser is on a tunnel').toBe('true')
    expect(await popover.locator('#tunnel-switch-nym').getAttribute('aria-checked')).toBe('true')
    await popover.click('#tunnel-tab-first')
    expect(await popover.locator('#tunnel-switch-nym').getAttribute('aria-checked')).toBe('true')
    expect(await notesOf(popover)).toContain('This tab follows the tunnel you set for all your browsing')

    await popover.click('#tunnel-switch-nym')
    expect(await waitFor(async () => await attribute(chrome, 'data-tunnel') === null)).toBe(true)
    expect(await attribute(chrome, 'aria-label')).toBe('Tunnels. Sites you open in this tab go direct')
    expect(await waitFor(async () => (await popover.locator('#tunnel-switch-nym').getAttribute('aria-checked')) === 'false')).toBe(true)
    expect(await notesOf(popover)).toContain('Direct for this tab: the sites you open here do not use a tunnel, while the rest of your browsing does.')
    await shoot(app, chrome, popover, 'tab-tunnel-button-direct-for-this-tab')
    await closeList(app, chrome)

    // The first address typed in that tab reaches the website outside the tunnel.
    const before = askedOfNym()
    const decoyBefore = decoy.hits()
    await clickAddressBarRetrying(chrome, url())
    expect((await waitForTab(chrome, { address: url(), title: 'direct' }, 60_000)).ok).toBe(true)
    expect(decoy.hits() - decoyBefore, 'a direct tab reaches the website outside the tunnel').toBeGreaterThan(0)
    expect(askedOfNym() - before, 'and Nym was not asked for it').toBe(0)
  } finally {
    await closeElectron(app)
  }
}, 6 * QA_TEST_TIMEOUT_MS)

it('[app:tab-tunnel-button-opens-the-moment-a-new-tab-shows] the tunnels button pressed in the same task that draws a new tab opens the list of that tab, with nothing waited for before the press', async () => {
  const { app, chrome } = await start()
  try {
    const first = await activeId(chrome)
    // The press comes from the chrome's own state listener, after the chrome has drawn the state that shows the new tab in front: the earliest
    // moment a person can press a button that is shown. A page that is not loaded yet is no reason for the button to do nothing.
    const drawn = await chrome.evaluate(async (previous) => await new Promise<{ isNewTab: boolean, url: string, label: string | null }>((resolve) => {
      interface Pushed { tabs: Array<{ id: string, url: string, isNewTab: boolean }>, activeTabId: string | null }
      const shell = (window as unknown as { orivonShell: { onState: (listener: (state: Pushed) => void) => () => void } }).orivonShell
      const button = document.querySelector<HTMLButtonElement>('#tunnel-btn') as HTMLButtonElement
      const stop = shell.onState((state) => {
        const active = state.tabs.find((tab) => tab.id === state.activeTabId)
        if (active === undefined || active.id === previous || button.hidden) return
        stop()
        button.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }))
        button.click()
        resolve({ isNewTab: active.isNewTab, url: active.url, label: button.getAttribute('aria-label') })
      })
      ;(document.querySelector('#new-tab') as HTMLElement).click()
    }), first)
    const opened = await waitFor(() => findPopup(app) !== undefined)
    expect.soft(drawn.isNewTab, `the first state that shows the new tab says it is the new tab (its address then: "${drawn.url}")`).toBe(true)
    expect.soft(drawn.label).toBe('Tunnels')
    expect(opened, 'the press opened the list').toBe(true)
    const popover = findPopup(app) as Page
    await popover.waitForSelector('#tunnel-switch-nym')
    expect(await popover.locator('#tunnel-tab-first').textContent(), 'the list is about the tab').toBe('This tab')
    await closeList(app, chrome)
  } finally {
    await closeElectron(app)
  }
}, 6 * QA_TEST_TIMEOUT_MS)

it('[app:tab-tunnel-button-blank-popup-of-a-tunnelled-tab-has-no-button] a blank popup a page opens in a tab given a tunnel is in that tunnel\'s session and is no new tab: its tunnel button is gone, and the page\'s comes back with the page', async () => {
  const { app, chrome } = await start()
  try {
    const popover = await openList(app, chrome)
    await popover.click('#tunnel-switch-nym')
    expect(await waitFor(async () => await attribute(chrome, 'data-tunnel') === 'on')).toBe(true)
    await closeList(app, chrome)
    await clickAddressBarRetrying(chrome, url())
    expect((await waitForTab(chrome, { address: url(), title: 'tunnelled' }, 60_000)).ok).toBe(true)
    expect(await waitFor(() => findViewShowing(app, chrome, url()) !== undefined)).toBe(true)
    const first = await activeId(chrome)

    // The popup holds no address yet and lives in the session of the page that opened it, so a new tab's words about its first address would describe it wrongly.
    await (findViewShowing(app, chrome, url()) as Page).click('#blank')
    expect(await waitFor(async () => (await tabIds(chrome)).length === 2 && await activeId(chrome) !== first)).toBe(true)
    expect(await waitFor(async () => !(await chrome.locator('#tunnel-btn').isVisible())), 'the blank popup has no tunnel button').toBe(true)

    const popup = await activeId(chrome)
    await chrome.evaluate((tab) => { (window as unknown as { orivonShell: { closeTab: (id: string) => void } }).orivonShell.closeTab(tab) }, popup)
    expect(await waitFor(async () => (await tabIds(chrome)).length === 1 && await activeId(chrome) === first)).toBe(true)
    expect(await waitFor(async () => await chrome.locator('#tunnel-btn').isVisible() && await attribute(chrome, 'data-tunnel') === 'on'), 'the page\'s button is back').toBe(true)
    expect(await attribute(chrome, 'aria-label')).toBe('Tunnels. This page goes through Nym. Set for this tab')
  } finally {
    await closeElectron(app)
  }
}, 6 * QA_TEST_TIMEOUT_MS)

it('[app:tab-tunnel-button-blank-popup-in-the-shared-session-has-no-button] a blank popup a page opens in a tab with no tunnel stays in the shared session and is no new tab: its tunnel button is gone, and the page\'s comes back with the page', async () => {
  const { app, chrome } = await start()
  try {
    await clickAddressBarRetrying(chrome, url())
    expect((await waitForTab(chrome, { address: url(), title: 'direct' }, 60_000)).ok).toBe(true)
    expect(await waitFor(() => findViewShowing(app, chrome, url()) !== undefined)).toBe(true)
    const first = await activeId(chrome)
    expect(await chrome.locator('#tunnel-btn').isVisible(), 'the page has the button before the popup opens').toBe(true)

    // The page writes into the popup, so a tunnel the person set here could not hold for what it loads: a new tab's words would be false.
    await (findViewShowing(app, chrome, url()) as Page).click('#blank')
    expect(await waitFor(async () => (await tabIds(chrome)).length === 2 && await activeId(chrome) !== first)).toBe(true)
    expect(await waitFor(async () => !(await chrome.locator('#tunnel-btn').isVisible())), 'the blank popup has no tunnel button').toBe(true)

    const popup = await activeId(chrome)
    await chrome.evaluate((tab) => { (window as unknown as { orivonShell: { closeTab: (id: string) => void } }).orivonShell.closeTab(tab) }, popup)
    expect(await waitFor(async () => (await tabIds(chrome)).length === 1 && await activeId(chrome) === first)).toBe(true)
    expect(await waitFor(async () => await chrome.locator('#tunnel-btn').isVisible()), 'the page\'s button is back').toBe(true)
    expect(await attribute(chrome, 'data-tunnel')).toBeNull()
    expect(await attribute(chrome, 'aria-label')).toBe('Tunnels')
  } finally {
    await closeElectron(app)
  }
}, 6 * QA_TEST_TIMEOUT_MS)

const loadingPages = async (app: ElectronApplication): Promise<number> => await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((wc) => wc.isLoading()).length)

/** Clicks a link of the page in front that opens `heldUrl()` in a new tab, and returns once that tab is in front, its request has reached the website, and nothing has been answered. */
async function openHeldInNewTab (app: ElectronApplication, chrome: Page, page: Page): Promise<void> {
  const first = await activeId(chrome)
  const before = held.requests()
  await page.evaluate((target) => { (document.querySelector('#out') as HTMLAnchorElement).href = target }, heldUrl())
  await page.click('#out')
  expect(await waitFor(async () => (await tabIds(chrome)).length === 2 && await activeId(chrome) !== first), 'the link opened a tab in front').toBe(true)
  expect(await waitFor(() => held.requests() > before), 'the new tab asked the website, which has not answered').toBe(true)
  expect(await loadingPages(app), 'a page is loading').toBeGreaterThan(0)
}

it('[app:tab-tunnel-button-opens-before-the-first-page-commits] the tunnels button pressed on a tab opened onto a website that has not answered yet opens the list of that website, and the same list once the page has come', async () => {
  const { app, chrome } = await start()
  try {
    await clickAddressBarRetrying(chrome, url())
    expect((await waitForTab(chrome, { address: url(), title: 'direct' }, 60_000)).ok).toBe(true)
    expect(await waitFor(() => findViewShowing(app, chrome, url()) !== undefined)).toBe(true)
    await openHeldInNewTab(app, chrome, findViewShowing(app, chrome, url()) as Page)
    expect(await chrome.locator('#tunnel-btn').isVisible(), 'the tab draws the button while its page has not committed').toBe(true)

    // Nothing has come from the website, so the tab has no address of its own yet: the press is about the address it is opening.
    const popover = await openList(app, chrome)
    expect(await loadingPages(app), 'the list opened while the page was still loading').toBeGreaterThan(0)
    expect(await popover.locator('.site-claim').textContent(), 'the list is the website\'s, not the tab\'s').toContain(`${NAME}:${String(held.port)}`)
    expect(await popover.locator('#tunnel-switch-nym').getAttribute('aria-label')).toBe('Use Nym for this site')

    // The page comes while the list is open: the list is not closed by the page taking the keyboard.
    held.release()
    expect((await waitForTab(chrome, { address: heldUrl(), title: 'held' }, 60_000)).ok).toBe(true)
    await delay(ABSENCE_SETTLE_MS)
    expect(findPopup(app) !== undefined, 'the list stays open when the page arrives').toBe(true)
    await closeList(app, chrome)

    // The same press on the page now shown opens the same list.
    const again = await openList(app, chrome)
    expect(await again.locator('.site-claim').textContent()).toContain(`${NAME}:${String(held.port)}`)
    await closeList(app, chrome)
  } finally {
    held.release()
    await closeElectron(app)
  }
}, 6 * QA_TEST_TIMEOUT_MS)

it('[app:tab-tunnel-button-opens-before-the-first-page-commits] the same press on a tab opened from a tab that carries a tunnel opens the list of the tab, since its choice covers the website before it has answered', async () => {
  const { app, chrome } = await start()
  try {
    const popover = await openList(app, chrome)
    await popover.click('#tunnel-switch-nym')
    expect(await waitFor(async () => await attribute(chrome, 'data-tunnel') === 'on')).toBe(true)
    await closeList(app, chrome)
    await clickAddressBarRetrying(chrome, url())
    expect((await waitForTab(chrome, { address: url(), title: 'tunnelled' }, 60_000)).ok).toBe(true)
    expect(await waitFor(() => findViewShowing(app, chrome, url()) !== undefined)).toBe(true)
    await openHeldInNewTab(app, chrome, findViewShowing(app, chrome, url()) as Page)

    const list = await openList(app, chrome)
    expect(await list.locator('#tunnel-tab-first').textContent(), 'the list is the tab\'s').toBe('This tab')
    expect(await list.locator('#tunnel-switch-nym').getAttribute('aria-checked'), 'the tab it was opened from handed it its choice').toBe('true')

    // The page comes while the tab's list is open: it is about the tab, so the arrival does not close it.
    held.release()
    expect((await waitForTab(chrome, { address: heldUrl(), title: 'held' }, 60_000)).ok).toBe(true)
    await delay(ABSENCE_SETTLE_MS)
    expect(findPopup(app) !== undefined, 'the tab\'s list stays open when the page arrives').toBe(true)
    expect(await list.locator('#tunnel-tab-first').textContent(), 'it is still the tab\'s').toBe('This tab')
    await closeList(app, chrome)
  } finally {
    held.release()
    await closeElectron(app)
  }
}, 6 * QA_TEST_TIMEOUT_MS)

it('[app:tab-tunnel-button-opens-before-the-first-page-commits] the same press on a tab that showed a website with a tunnel of its own, once an address has been typed in it that has not answered, opens the list of that address', async () => {
  const { app, chrome } = await start()
  try {
    // The website gets a tunnel of its own, so the tab shows it in the session that tunnel calls for: typing another address leaves that session.
    await clickAddressBarRetrying(chrome, url())
    expect((await waitForTab(chrome, { address: url(), title: 'direct' }, 60_000)).ok).toBe(true)
    const popover = await openList(app, chrome)
    await popover.click('#tunnel-switch-nym')
    await popover.waitForSelector('.tunnel-notice')
    await popover.click('#tunnel-notice-confirm')
    expect((await waitForTab(chrome, { address: url(), title: 'tunnelled' }, 60_000)).ok, 'the website came through Nym').toBe(true)
    if (findPopup(app) !== undefined) await chrome.click('#tunnel-btn')
    expect(await waitFor(() => findPopup(app) === undefined)).toBe(true)
    await delay(300)

    // The view in that session is put away on a blank page as the new address starts to load: that page's end is not the end of the load.
    const before = held.requests()
    await clickAddressBarRetrying(chrome, heldUrl())
    expect(await waitFor(() => held.requests() > before), 'the new address was asked for and has not answered').toBe(true)
    await delay(ABSENCE_SETTLE_MS)
    expect(await loadingPages(app), 'a page is loading').toBeGreaterThan(0)
    expect(await chrome.locator('#tunnel-btn').isVisible(), 'the tab draws the button while its page has not committed').toBe(true)
    const list = await openList(app, chrome)
    expect(await list.locator('.site-claim').textContent(), 'the list is the one of the address being opened').toContain(`${NAME}:${String(held.port)}`)
    expect(await list.locator('#tunnel-switch-nym').getAttribute('aria-label')).toBe('Use Nym for this site')
    held.release()
    expect((await waitForTab(chrome, { address: heldUrl(), title: 'held' }, 60_000)).ok).toBe(true)
    await closeList(app, chrome)
  } finally {
    held.release()
    await closeElectron(app)
  }
}, 6 * QA_TEST_TIMEOUT_MS)

it('[app:tab-tunnel-button-opens-before-the-first-page-commits] a popup a page opened onto a website that has not answered has no tunnel button, whether or not the page cuts its link to the popup afterwards, and has the button once its page has come', async () => {
  const { app, chrome } = await start()
  try {
    await clickAddressBarRetrying(chrome, url())
    expect((await waitForTab(chrome, { address: url(), title: 'direct' }, 60_000)).ok).toBe(true)
    expect(await waitFor(() => findViewShowing(app, chrome, url()) !== undefined)).toBe(true)
    const first = await activeId(chrome)
    for (const button of ['sized', 'sizedCut']) {
      // The page writes into the popup's empty document as freely as into its own until the website answers, so the button is not drawn: a press could only be about what the page says it loads.
      held.release()
      await delay(ABSENCE_SETTLE_MS)
      const before = held.requests()
      const page = findViewShowing(app, chrome, url()) as Page
      await page.evaluate(({ id, target }) => { (document.querySelector(`#${id}`) as HTMLElement).dataset.target = target }, { id: button, target: heldUrl() })
      await page.click(`#${button}`)
      expect(await waitFor(async () => (await tabIds(chrome)).length === 2 && await activeId(chrome) !== first), `${button}: the popup is the tab in front`).toBe(true)
      expect(await waitFor(() => held.requests() > before), `${button}: the popup asked the website, which has not answered`).toBe(true)
      expect(await waitFor(async () => !(await chrome.locator('#tunnel-btn').isVisible())), `${button}: the popup has no button while its page has not come`).toBe(true)
      if (button === 'sizedCut') {
        // The page cuts its link after the popup began to load; the tab is brought to the front again so that its state is read once more, with no opener left to read.
        await delay(ABSENCE_SETTLE_MS)
        const popupId = await activeId(chrome)
        await chrome.click('#new-tab')
        expect(await waitFor(async () => (await tabIds(chrome)).length === 3 && await activeId(chrome) !== popupId)).toBe(true)
        const extra = await activeId(chrome)
        await chrome.evaluate((tab) => { (window as unknown as { orivonShell: { closeTab: (id: string) => void } }).orivonShell.closeTab(tab) }, extra)
        expect(await waitFor(async () => (await tabIds(chrome)).length === 2 && await activeId(chrome) === popupId)).toBe(true)
        await delay(ABSENCE_SETTLE_MS)
        expect(await chrome.locator('#tunnel-btn').isVisible(), `${button}: still no button once the page has cut the link`).toBe(false)
      }

      held.release()
      expect((await waitForTab(chrome, { address: heldUrl(), title: 'held' }, 60_000)).ok, `${button}: the page came`).toBe(true)
      expect(await waitFor(async () => await chrome.locator('#tunnel-btn').isVisible()), `${button}: the button comes with the page`).toBe(true)
      const popup = await activeId(chrome)
      await chrome.evaluate((tab) => { (window as unknown as { orivonShell: { closeTab: (id: string) => void } }).orivonShell.closeTab(tab) }, popup)
      expect(await waitFor(async () => (await tabIds(chrome)).length === 1 && await activeId(chrome) === first)).toBe(true)
    }
  } finally {
    held.release()
    await closeElectron(app)
  }
}, 6 * QA_TEST_TIMEOUT_MS)
