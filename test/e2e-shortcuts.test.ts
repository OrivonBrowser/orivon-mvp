// Keyboard shortcuts in the running shell: the defaults act on the window a key
// was pressed in and never reach the page, a key nothing is bound to still
// does, and Settings can change, swap, clear and restore them.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from './launch-electron.mjs'
import { clickAddressBarRetrying, pressKey } from './e2e-helpers.js'
import { bookmarkUrls, delay, evaluateRetrying, findChrome, HERMETIC_RESOLVER, popoverShown, tabIds, waitFor, waitForTab } from './smoke-helpers.mjs'

let server: Server
let siteUrl = ''
let requests = 0

beforeAll(async () => {
  server = createServer((_request, response) => {
    requests += 1
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html><title>a site</title><input id="in"><script>window.__keys = []; addEventListener("keydown", (e) => window.__keys.push(e.key))</script>')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  siteUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 70_000
const chromePages = (app: ElectronApplication): Page[] => app.windows().filter((w) => w.url().endsWith('/renderer/index.html'))
const settingsPage = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().startsWith('orivon://settings'))

async function launchedOnSite (): Promise<{ app: ElectronApplication, chrome: Page, site: Page }> {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  const chrome = findChrome(app)
  await clickAddressBarRetrying(chrome, siteUrl)
  expect((await waitForTab(chrome, { address: siteUrl })).ok).toBe(true)
  const site = app.windows().find((w) => w.url() === siteUrl) as Page
  return { app, chrome, site }
}

const tabCount = async (chrome: Page): Promise<number> => (await tabIds(chrome)).length

it('runs the default shortcuts on the window they were pressed in, and the page never sees them', async () => {
  const { app, chrome, site } = await launchedOnSite()
  try {
    // The application menu is gone, so nothing takes a key before the browser's own handling.
    expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu())).toBeNull()

    await pressKey(app, siteUrl, 'T', ['control'])
    expect(await waitFor(async () => await tabCount(chrome) === 2)).toBe(true)
    await pressKey(app, siteUrl, 'W', ['control'])
    expect(await waitFor(async () => await tabCount(chrome) === 1)).toBe(true)

    // Reload, and the address bar.
    const before = requests
    await pressKey(app, siteUrl, 'F5')
    expect(await waitFor(() => requests > before)).toBe(true)
    await pressKey(app, siteUrl, 'L', ['control'])
    expect(await waitFor(async () => await evaluateRetrying(chrome, () => document.activeElement?.id) === 'address')).toBe(true)

    // Bookmark and un-bookmark.
    await pressKey(app, siteUrl, 'D', ['control'])
    expect(await waitFor(async () => (await bookmarkUrls(chrome)).length === 1)).toBe(true)
    await pressKey(app, siteUrl, 'D', ['control'])
    expect(await waitFor(async () => (await bookmarkUrls(chrome)).length === 0)).toBe(true)

    // Tabs by number and by order.
    await pressKey(app, siteUrl, 'T', ['control'])
    await pressKey(app, siteUrl, 'T', ['control'])
    expect(await waitFor(async () => await tabCount(chrome) === 3)).toBe(true)
    const [first, second] = await tabIds(chrome)
    await pressKey(app, siteUrl, '1', ['control'])
    expect(await waitFor(async () => (await waitForTab(chrome, { activeId: first })).ok)).toBe(true)
    await pressKey(app, siteUrl, 'Tab', ['control'])
    expect((await waitForTab(chrome, { activeId: second })).ok).toBe(true)

    // Windows and Settings.
    await pressKey(app, siteUrl, 'N', ['control'])
    expect(await waitFor(() => chromePages(app).length === 2)).toBe(true)
    await pressKey(app, siteUrl, ',', ['control'])
    expect(await waitFor(() => settingsPage(app) !== undefined)).toBe(true)

    // None of that reached the page; a key nothing is bound to does.
    expect(await site.evaluate(() => (window as unknown as { __keys: string[] }).__keys)).toEqual([])
    await pressKey(app, siteUrl, 'A')
    expect(await waitFor(async () => (await site.evaluate(() => (window as unknown as { __keys: string[] }).__keys)).includes('a'))).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

async function openShortcuts (app: ElectronApplication, chrome: Page): Promise<Page> {
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path: string) => void } }).orivonShell.openInternal('settings', '/shortcuts') })
  expect(await waitFor(() => settingsPage(app) !== undefined)).toBe(true)
  const page = settingsPage(app) as Page
  await page.waitForSelector('[id="row-shortcut-tab.new"]')
  return page
}

it('changes a shortcut, refuses a bad one, trades two, clears one, restores them, and saves what differs', async () => {
  const { app, chrome } = await launchedOnSite()
  try {
    const userData = await app.evaluate(({ app: electron }) => electron.getPath('userData'))
    const settings = await openShortcuts(app, chrome)
    const row = (id: string): ReturnType<Page['locator']> => settings.locator(`[id="row-shortcut-${id}"]`)
    const keys = async (id: string): Promise<string[]> => await row(id).locator('.shortcut > .keys').first().locator('kbd').allTextContents()
    const start = await tabCount(chrome)

    // Change New tab to Ctrl+Alt+Y.
    await row('tab.new').getByRole('button', { name: 'Change' }).click()
    await settings.waitForSelector('.listening')
    await pressKey(app, 'orivon://settings', 'Y', ['control', 'alt'])
    expect(await waitFor(async () => (await keys('tab.new')).join('+') === 'Ctrl+Alt+Y')).toBe(true)
    await pressKey(app, 'orivon://settings', 'Y', ['control', 'alt'])
    expect(await waitFor(async () => await tabCount(chrome) === start + 1)).toBe(true)
    await pressKey(app, 'orivon://settings', 'T', ['control'])
    await delay(500)
    expect(await tabCount(chrome)).toBe(start + 1)
    // The new tab took the screen; closing it brings Settings back.
    await pressKey(app, 'orivon://settings', 'W', ['control'])
    expect(await waitFor(async () => await tabCount(chrome) === start)).toBe(true)

    // A combination the rules refuse says why and changes nothing.
    await row('tab.new').getByRole('button', { name: 'Change' }).click()
    await pressKey(app, 'orivon://settings', 'C', ['control'])
    expect(await settings.locator('.problem').first().textContent()).toContain('copying')
    expect((await keys('tab.new')).join('+')).toBe('Ctrl+Alt+Y')

    // Escape gives up.
    await row('tab.new').getByRole('button', { name: 'Change' }).click()
    await pressKey(app, 'orivon://settings', 'Escape')
    expect(await waitFor(async () => await settings.locator('.listening').count() === 0)).toBe(true)

    // Taking Ctrl+W from Close tab offers a swap.
    await row('tab.new').getByRole('button', { name: 'Change' }).click()
    await pressKey(app, 'orivon://settings', 'W', ['control'])
    expect(await settings.locator('.problem').first().textContent()).toContain('Close tab')
    await row('tab.new').getByRole('button', { name: 'Swap' }).click()
    expect(await waitFor(async () => (await keys('tab.new')).join('+') === 'Ctrl+W')).toBe(true)
    expect(await waitFor(async () => (await keys('tab.close')).join('+') === 'Ctrl+Alt+Y')).toBe(true)

    // The file on disk holds only what differs, and a restart would read it.
    expect(await waitFor(async () => {
      try {
        const saved = JSON.parse(await readFile(join(userData, 'shortcuts.json'), 'utf8')) as { bindings: Record<string, string> }
        return saved.bindings['tab.new'] === 'Mod+W' && saved.bindings['tab.close'] === 'Mod+Alt+Y'
      } catch { return false }
    })).toBe(true)

    // Clear one, then restore everything.
    await row('nav.reload').getByRole('button', { name: 'Clear' }).click()
    expect(await waitFor(async () => await row('nav.reload').getByText('Not set').count() === 1)).toBe(true)
    await settings.getByRole('button', { name: 'Restore defaults' }).click()
    await settings.getByRole('button', { name: 'Click again to restore' }).click()
    expect(await waitFor(async () => (await keys('tab.new')).join('+') === 'Ctrl+T')).toBe(true)
    expect((await keys('nav.reload')).join('+')).toBe('Ctrl+R')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('quits on its shortcut, and a change made a moment before is on disk', async () => {
  const { app, chrome } = await launchedOnSite()
  try {
    const userData = await app.evaluate(({ app: electron }) => electron.getPath('userData'))
    await pressKey(app, siteUrl, 'D', ['control'])
    expect(await waitFor(async () => (await bookmarkUrls(chrome)).length === 1)).toBe(true)
    const exit = new Promise<number | null>((resolve) => { app.process().once('exit', (code) => { resolve(code) }) })

    // The write is debounced; quitting must wait for it.
    await pressKey(app, siteUrl, 'Q', ['control', 'shift']).catch(() => {})

    expect(await Promise.race([exit, delay(15_000).then(() => 'still running' as const)])).toBe(0)
    const saved = JSON.parse(await readFile(join(userData, 'bookmarks.json'), 'utf8')) as Array<{ url: string }>
    expect(saved.map((bookmark) => bookmark.url)).toEqual([siteUrl])
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('opens the main menu from the toolbar, lists commands under their keys, and runs the one chosen', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
    const chrome = findChrome(app)
    const menuPage = (): Page | undefined => app.windows().find((w) => w.url().endsWith('/menu/index.html'))

    await chrome.click('#menu')
    expect(await waitFor(() => menuPage() !== undefined)).toBe(true)
    const menu = menuPage() as Page
    await menu.waitForSelector('.item')
    const entries = await menu.locator('.item').allTextContents()
    expect(entries).toContain('New tabCtrl+T')
    expect(entries).toContain('Open SettingsCtrl+,')

    await menu.locator('.item', { hasText: 'Open Settings' }).click()

    expect(await waitFor(() => settingsPage(app) !== undefined)).toBe(true)
    // Not menuPage() === undefined: the menu is kept warm (shell/popover-
    // view.ts's `warm`), so its webContents survives being hidden and
    // app.windows() keeps listing it -- popoverShown reads whether it is
    // actually attached to the screen instead.
    expect(await waitFor(async () => !(await popoverShown(app, '/menu/')))).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
