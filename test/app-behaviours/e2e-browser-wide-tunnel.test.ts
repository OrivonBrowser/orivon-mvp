// The tunnels popup has two panels, the tab's own and Browser-wide, driven with the real button and the real popup. The first
// panel opens by default; Browser-wide sets a tunnel for the whole browser (Settings then shows the browser-wide switch on) and
// asks nothing while no tab keeps a tunnel of its own; the next open on a tab with no choice lands on Browser-wide, and on a tab
// with a choice on its own panel. While a tab keeps its own tunnel, turning one on browser-wide first lists that tab with what it
// keeps, and nothing changes until Proceed; turning it off asks nothing. The switch for the IPFS and Swarm nodes is on
// Browser-wide only, and cannot be moved while no tunnel is on. The Nym module is the stand-in `e2e-tab-tunnel-button` uses.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-browser-wide-tunnel.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import { delay, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

/** A title with markup in it, as a website may write: the prompt must show it as the text it is. */
const BANK_TITLE = 'Bank <b>tab</b>'
const PROMPT = 'You are setting this tunnel browser-wide, but some tabs will keep using their tab-specific tunnel.'

let dir: string
let moduleDir: string
let configFile: string
let bank: { port: number, close: () => Promise<void> }
const cleanups: Array<() => Promise<void> | void> = []
const bankUrl = (): string => `http://127.0.0.1:${String(bank.port)}/`

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-browser-wide-tunnel-e2e-'))
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
  moduleDir = join(dir, 'module')
  mkdirSync(moduleDir)
  writeFileSync(join(moduleDir, 'smolmix_wasm.js'), FAKE_NYM_MODULE)
  writeFileSync(join(moduleDir, 'smolmix_wasm_bg.wasm'), EMPTY_WASM)
  const server: Server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }).end(`<!doctype html><title>${BANK_TITLE.replace(/</g, '&lt;')}</title><body>bank</body>`) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  bank = { port: (server.address() as AddressInfo).port, close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }) } }
  cleanups.push(async () => { await bank.close() })
  configFile = join(dir, 'fake.json')
  writeFileSync(configFile, JSON.stringify({ failStart: false, log: join(dir, 'fake.log'), targets: {} }))
  writeFileSync(join(dir, 'fake.log'), '')
}, 60_000)

afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function start (settings: Record<string, unknown> = {}): Promise<{ app: ElectronApplication, chrome: Page }> {
  return await launchShell({
    env: { ORIVON_TEST_NYM_MODULE: moduleDir, ORIVON_TEST_NYM_FAKE: configFile },
    args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
    seedProfile: async (userDataDir) => { writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ version: 1, values: settings })) }
  })
}

const findPopup = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().includes('/site-info/') && !w.isClosed())

/** Presses the tunnels button and returns the popup it opens, once its rows are drawn. */
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

const selectedPanel = async (popover: Page): Promise<string> => (await popover.locator('[role="tab"][aria-selected="true"]').textContent()) ?? ''
const checked = async (popover: Page, id: string): Promise<boolean> => (await popover.locator(`#${id}`).getAttribute('aria-checked')) === 'true'
const whenChecked = async (popover: Page, id: string, on: boolean): Promise<boolean> => await waitFor(async () => await checked(popover, id) === on)

/** What Settings says of the three settings the Browser-wide panel moves. */
async function settingsSay (app: ElectronApplication, chrome: Page): Promise<{ kind: string, everywhere: boolean, nodes: boolean }> {
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/tunnels') })
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
  const settings = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
  await settings.waitForSelector('#row-route-everywhere input[type=checkbox]')
  const said = {
    kind: await settings.locator('#row-route-kind select').inputValue(),
    everywhere: await settings.locator('#row-route-everywhere input[type=checkbox]').isChecked(),
    nodes: await settings.locator('#row-route-nodes input[type=checkbox]').isChecked()
  }
  await settings.close()
  return said
}

it('[app:browser-wide-tunnel-sets-the-whole-browser] the first panel opens by default; Browser-wide sets a tunnel for the whole browser with no question while no tab keeps its own, the nodes switch is on that panel only and moves only while a tunnel is on, and the next open lands on Browser-wide', async () => {
  const { app, chrome } = await start()
  try {
    let popover = await openList(app, chrome)
    expect(await popover.locator('[role="tab"]').allTextContents(), 'the two panels, the tab\'s own first').toEqual(['This tab', 'Browser-wide'])
    expect(await selectedPanel(popover), 'with no tunnel on browser-wide the tab\'s own panel opens').toBe('This tab')
    expect(await popover.locator('#tunnel-switch-nodes').count(), 'the nodes switch is not on the tab\'s own panel').toBe(0)
    expect(await popover.locator('#tunnel-settings-open').textContent()).toBe('Open Tunnels settings')

    await popover.click('#tunnel-tab-browser')
    expect(await selectedPanel(popover)).toBe('Browser-wide')
    expect(await popover.locator('.site-claim').count(), 'the whole browser has no name under the title').toBe(0)
    expect(await popover.locator('.tunnel-row[data-tunnel]').count()).toBe(2)
    expect(await popover.locator('#tunnel-switch-nym').getAttribute('aria-label')).toBe('Use Nym for the whole browser')
    expect(await checked(popover, 'tunnel-switch-nym')).toBe(false)
    expect(await popover.locator('.tunnel-nodes .tunnel-label').textContent()).toBe('Also use for IPFS and Swarm nodes')
    expect(await popover.locator('.tunnel-nodes .tunnel-state').textContent()).toBe('More private, but pages from these networks load more slowly.')
    expect(await popover.locator('#tunnel-switch-nodes').isDisabled(), 'while no tunnel is on browser-wide the nodes switch does nothing, so it is held').toBe(true)
    expect(await popover.locator('#tunnel-settings-open').textContent(), 'the same link on both panels').toBe('Open Tunnels settings')
    await shoot(app, chrome, popover, 'browser-wide-off')

    await popover.click('#tunnel-switch-nym')
    expect(await whenChecked(popover, 'tunnel-switch-nym', true), 'Nym is on browser-wide').toBe(true)
    expect(await popover.locator('.tunnel-notice').count(), 'no tab keeps a tunnel of its own, so nothing is asked').toBe(0)
    expect(await popover.locator('.tunnel-row[data-tunnel="nym"] .tunnel-state').textContent()).toContain('This browser\'s traffic goes through Nym')
    expect(await popover.locator('#tunnel-switch-nodes').isDisabled(), 'the nodes switch moves now that a tunnel is on').toBe(false)
    await popover.click('#tunnel-switch-nodes')
    expect(await whenChecked(popover, 'tunnel-switch-nodes', true)).toBe(true)
    await shoot(app, chrome, popover, 'browser-wide-on')
    await closeList(app, chrome)

    // The next press on a tab with no choice of its own lands on the panel of the whole browser.
    popover = await openList(app, chrome)
    expect(await selectedPanel(popover)).toBe('Browser-wide')
    expect(await checked(popover, 'tunnel-switch-nym')).toBe(true)
    expect(await checked(popover, 'tunnel-switch-nodes')).toBe(true)
    await popover.click('#tunnel-tab-first')
    expect(await popover.locator('#tunnel-switch-nodes').count()).toBe(0)
    expect(await checked(popover, 'tunnel-switch-nym'), 'the tab follows the browser').toBe(true)

    // Another tunnel browser-wide: the proxy asks for its address first, and saving it sets it, with Nym given up.
    await popover.click('#tunnel-tab-browser')
    await popover.click('#tunnel-switch-socks5')
    await popover.fill('#tunnel-proxy-address', '127.0.0.1:9')
    await popover.click('#tunnel-proxy-save')
    expect(await whenChecked(popover, 'tunnel-switch-socks5', true), 'the proxy is the browser-wide tunnel').toBe(true)
    expect(await checked(popover, 'tunnel-switch-nym')).toBe(false)
    await closeList(app, chrome)

    expect(await settingsSay(app, chrome), 'Settings says what the panel set: the tunnel, the whole browser on it, the nodes following').toEqual({ kind: 'socks5', everywhere: true, nodes: true })
  } finally {
    await closeElectron(app)
  }
}, 8 * QA_TEST_TIMEOUT_MS)

it('[app:browser-wide-tunnel-panel-opens-where-the-tab-stands] with the whole browser on a tunnel the popup opens on Browser-wide for a tab with no choice of its own, and on its own panel for a tab that keeps one', async () => {
  const { app, chrome } = await start({ 'network.tunnel.everywhere': true })
  try {
    let popover = await openList(app, chrome)
    expect(await selectedPanel(popover), 'a tab that follows the browser opens on Browser-wide').toBe('Browser-wide')
    expect(await checked(popover, 'tunnel-switch-nym')).toBe(true)

    // The tab is sent direct from its own panel, so it keeps a choice of its own.
    await popover.click('#tunnel-tab-first')
    await popover.click('#tunnel-switch-nym')
    expect(await waitFor(async () => await chrome.getAttribute('#tunnel-btn', 'data-tunnel') === null), 'only this tab left the tunnel').toBe(true)
    expect(await whenChecked(popover, 'tunnel-switch-nym', false)).toBe(true)
    await closeList(app, chrome)

    popover = await openList(app, chrome)
    expect(await selectedPanel(popover), 'a tab with its own choice opens on its own panel, though the browser is on a tunnel').toBe('This tab')
    expect(await checked(popover, 'tunnel-switch-nym')).toBe(false)
    await popover.click('#tunnel-tab-browser')
    expect(await checked(popover, 'tunnel-switch-nym'), 'and Browser-wide still shows the browser on Nym').toBe(true)
    expect(await popover.locator('#tunnel-switch-nodes').isDisabled()).toBe(false)
    await closeList(app, chrome)

    // A tab opened now has no choice, so it opens on Browser-wide.
    await chrome.click('#new-tab')
    expect(await waitFor(async () => await chrome.locator('#tunnel-btn').isVisible())).toBe(true)
    popover = await openList(app, chrome)
    expect(await selectedPanel(popover)).toBe('Browser-wide')
    await closeList(app, chrome)
  } finally {
    await closeElectron(app)
  }
}, 6 * QA_TEST_TIMEOUT_MS)

it('[app:browser-wide-tunnel-asks-before-tabs-keep-their-own] turning a tunnel on browser-wide while a tab keeps its own lists that tab with what it keeps, changes nothing on Cancel and sets it on Proceed; turning it off asks nothing', async () => {
  const { app, chrome } = await start({ 'network.tunnel.everywhere': true })
  try {
    // One tab keeps a direct choice and shows a page whose title carries markup.
    let popover = await openList(app, chrome)
    await popover.click('#tunnel-tab-first')
    await popover.click('#tunnel-switch-nym')
    expect(await waitFor(async () => await chrome.getAttribute('#tunnel-btn', 'data-tunnel') === null)).toBe(true)
    await closeList(app, chrome)
    await clickAddressBarRetrying(chrome, bankUrl())
    expect((await waitForTab(chrome, { address: bankUrl(), title: BANK_TITLE }, 60_000)).ok).toBe(true)

    // Another tab follows the browser, and turns the browser-wide tunnel off: nothing is asked.
    await chrome.click('#new-tab')
    expect(await waitFor(async () => await chrome.locator('#tunnel-btn').isVisible())).toBe(true)
    popover = await openList(app, chrome)
    expect(await selectedPanel(popover)).toBe('Browser-wide')
    await popover.click('#tunnel-switch-nym')
    expect(await whenChecked(popover, 'tunnel-switch-nym', false)).toBe(true)
    expect(await popover.locator('.tunnel-notice').count(), 'turning the tunnel off asks nothing').toBe(0)
    expect(await popover.locator('#tunnel-switch-nodes').isDisabled(), 'with no tunnel on browser-wide the nodes switch is held again').toBe(true)

    // Turning it on lists the tab that keeps its own, and sets nothing yet.
    await popover.click('#tunnel-switch-nym')
    await popover.waitForSelector('#tunnel-prompt-cancel')
    expect(await popover.locator('.tunnel-notice-text').textContent()).toBe(PROMPT)
    expect(await popover.locator('.tunnel-kept-row').count(), 'the one tab that keeps a choice').toBe(1)
    expect(await popover.locator('.tunnel-kept-title').textContent(), 'the title as the website wrote it, shown as text').toBe(BANK_TITLE)
    expect(await popover.locator('.tunnel-kept-title b').count(), 'never read as markup').toBe(0)
    expect(await popover.locator('.tunnel-kept-via').textContent(), 'a tab that goes direct is listed too').toBe('Direct')
    expect(await popover.evaluate(() => document.activeElement?.id), 'the keyboard is on Cancel').toBe('tunnel-prompt-cancel')
    await popover.click('#tunnel-prompt-cancel')
    expect(await popover.locator('.tunnel-notice').count()).toBe(0)
    expect(await checked(popover, 'tunnel-switch-nym'), 'Cancel leaves the switches where they were').toBe(false)
    await closeList(app, chrome)
    popover = await openList(app, chrome)
    expect(await selectedPanel(popover), 'the browser is still on no tunnel').toBe('This tab')
    await popover.click('#tunnel-tab-browser')
    expect(await checked(popover, 'tunnel-switch-nym'), 'nothing was set').toBe(false)

    // Proceed sets it.
    await popover.click('#tunnel-switch-nym')
    await popover.waitForSelector('#tunnel-prompt-proceed')
    await popover.click('#tunnel-prompt-proceed')
    expect(await whenChecked(popover, 'tunnel-switch-nym', true)).toBe(true)
    expect(await popover.locator('.tunnel-notice').count()).toBe(0)
    await closeList(app, chrome)
    expect((await settingsSay(app, chrome)).everywhere, 'the whole browser is on the tunnel').toBe(true)
  } finally {
    await closeElectron(app)
  }
}, 8 * QA_TEST_TIMEOUT_MS)
