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
import type { Server } from 'node:http'
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
import { activeTabInfo, delay, findViewShowing, tabIds, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

const NAME = 'plain.nym.test'

interface Hosted { port: number, hits: () => number, close: () => Promise<void> }

async function host (title: string): Promise<Hosted> {
  let hits = 0
  const server: Server = createServer((_request, response) => { hits += 1; response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }).end(`<!doctype html><title>${title}</title><body>${title}<button id="blank" onclick="window.open('about:blank')">blank</button></body>`) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return { port: (server.address() as AddressInfo).port, hits: () => hits, close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }) } }
}

let dir: string
let decoy: Hosted
let real: Hosted
let nymLog: string
let moduleDir: string
let configFile: string
const cleanups: Array<() => Promise<void> | void> = []
const url = (): string => `http://${NAME}:${String(decoy.port)}/`
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
  cleanups.push(async () => { await decoy.close(); await real.close() })
  nymLog = join(dir, 'fake.log')
  writeFileSync(nymLog, '')
  configFile = join(dir, 'fake.json')
  writeFileSync(configFile, JSON.stringify({ failStart: false, log: nymLog, targets: { [`${NAME}:${String(decoy.port)}`]: { host: '127.0.0.1', port: real.port } } }))
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
    expect(await popover.locator('.site-claim').textContent(), 'the list is about the tab, not a site').toBe('This tab')
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
    expect(await popover.locator('.site-claim').textContent()).toBe('This tab')
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
