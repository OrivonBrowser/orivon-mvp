// The overlay facility, proven through the main menu: no overlay renderer at
// launch, one built on the button's hover, a zoom row that keeps the menu open
// and shows the new level, a submenu with a way back, Escape, resize and
// keyboard operation. Set ORIVON_UI_SHOTS_DIR to also write screenshots of the
// window with the menu open, in both colour schemes.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from './support/launch-electron.mjs'
import { clickAddressBarRetrying, pressKey } from './support/e2e-helpers.js'
import { ABSENCE_SETTLE_MS, delay, evaluateRetrying, findChrome, HERMETIC_RESOLVER, popoverShown, tabIds, waitFor, waitForTab } from './support/smoke-helpers.mjs'

const TEST_TIMEOUT_MS = 90_000
const SHOTS_DIR = process.env.ORIVON_UI_SHOTS_DIR
const SILENT = { env: { PULSE_SERVER: 'unix:/nonexistent' }, args: [HERMETIC_RESOLVER, '--alsa-output-device=null'] }

let server: Server
let siteUrl = ''

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html><title>a site</title><h1>a site</h1><input id="in">')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  siteUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type App = ElectronApplication

const overlayIds = async (app: App): Promise<number[]> =>
  await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((wc) => wc.getURL().includes('overlay=')).map((wc) => wc.id))

const menuPage = (app: App): Page | undefined => app.windows().find((w) => w.url().includes('overlay=menu'))
const menuShown = async (app: App): Promise<boolean> => await popoverShown(app, 'overlay=menu')

async function launched (onSite: boolean): Promise<{ app: App, chrome: Page }> {
  const app = await launchElectron({ appPath: '.', ...SILENT })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  const chrome = findChrome(app)
  if (onSite) {
    await clickAddressBarRetrying(chrome, siteUrl)
    expect((await waitForTab(chrome, { address: siteUrl })).ok).toBe(true)
  }
  return { app, chrome }
}

async function openMenu (app: App, chrome: Page): Promise<Page> {
  await chrome.click('#menu')
  expect(await waitFor(async () => await menuShown(app))).toBe(true)
  expect(await waitFor(() => menuPage(app) !== undefined)).toBe(true)
  const menu = menuPage(app) as Page
  await menu.waitForSelector('.menu-row')
  return menu
}

async function closeMenu (app: App, menu: Page): Promise<void> {
  await menu.keyboard.press('Escape')
  expect(await waitFor(async () => !(await menuShown(app)))).toBe(true)
  // Past the reopen debounce, so the next click is read as a fresh one.
  await delay(350)
}

const rowLabels = async (menu: Page): Promise<string[]> => await menu.locator('.menu-row .menu-label').allTextContents()
const percent = async (menu: Page): Promise<string> => (await menu.locator('.zoom-pct').textContent()) ?? ''
const focusedKey = async (menu: Page): Promise<string | null> =>
  await evaluateRetrying(menu, () => document.activeElement instanceof HTMLElement ? document.activeElement.dataset['key'] ?? null : null)

async function shoot (app: App, chrome: Page, menu: Page, name: string): Promise<void> {
  if (SHOTS_DIR === undefined) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await chrome.emulateMedia({ colorScheme: scheme })
    await menu.emulateMedia({ colorScheme: scheme })
    await delay(300)
    execFileSync('import', ['-window', 'root', join(SHOTS_DIR, `${name}-${scheme}.png`)])
    await menu.screenshot({ path: join(SHOTS_DIR, `${name}-card-${scheme}.png`) })
  }
  await chrome.emulateMedia({ colorScheme: null })
  await menu.emulateMedia({ colorScheme: null })
  expect(app).toBeDefined()
}

it('builds no overlay at launch, builds the menu on the button\'s hover, and lists the entries', async () => {
  const { app, chrome } = await launched(false)
  try {
    await delay(ABSENCE_SETTLE_MS)
    expect(await overlayIds(app)).toEqual([])

    await chrome.hover('#menu')
    expect(await waitFor(async () => (await overlayIds(app)).length === 1)).toBe(true)
    expect(await menuShown(app)).toBe(false)

    const menu = await openMenu(app, chrome)
    const labels = await rowLabels(menu)
    expect(labels).toEqual(expect.arrayContaining(['New tab', 'New window', 'New private window', 'History', 'Bookmark this page', 'More tools', 'Extensions', 'Profiles', 'Open Settings', 'Quit Orivon']))
    expect(await menu.locator('.menu-zoom').count()).toBe(1)
    expect(await menu.locator('.menu-row', { hasText: 'New tab' }).locator('.menu-keys').textContent()).toBe('Ctrl+T')
    expect(await menu.locator('[role="menu"]').getAttribute('aria-label')).toBe('Main menu')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('the zoom row keeps the menu open and shows the new level, the chip agrees, and the level resets', async () => {
  const { app, chrome } = await launched(true)
  try {
    const menu = await openMenu(app, chrome)
    expect(await percent(menu)).toBe('100%')

    await menu.getByRole('menuitem', { name: 'Zoom in' }).click()
    expect(await waitFor(async () => await percent(menu) === '110%')).toBe(true)
    expect(await menuShown(app)).toBe(true)
    expect(await waitFor(async () => await evaluateRetrying(chrome, () => document.querySelector<HTMLElement>('#zoom-chip')?.textContent) === '110%')).toBe(true)

    await menu.getByRole('menuitem', { name: 'Zoom out' }).click()
    await menu.getByRole('menuitem', { name: 'Zoom out' }).click()
    expect(await waitFor(async () => await percent(menu) === '90%')).toBe(true)

    await menu.locator('.zoom-pct').click()
    expect(await waitFor(async () => await percent(menu) === '100%')).toBe(true)
    expect(await menuShown(app)).toBe(true)
    await shoot(app, chrome, menu, 'menu-root')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('the zoom controls are off on a page with no zoom of its own', async () => {
  const { app, chrome } = await launched(false)
  try {
    const menu = await openMenu(app, chrome)
    expect(await menu.getByRole('menuitem', { name: 'Zoom in' }).isDisabled()).toBe(true)
    expect(await menu.getByRole('menuitem', { name: 'Full screen' }).isDisabled()).toBe(false)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('a submenu replaces the list under a back row, and Escape goes back before it closes', async () => {
  const { app, chrome } = await launched(true)
  try {
    const menu = await openMenu(app, chrome)
    await menu.locator('.menu-row', { hasText: 'More tools' }).click()
    await menu.waitForSelector('.menu-back')
    expect(await menu.locator('.menu-back').textContent()).toContain('More tools')
    expect(await rowLabels(menu)).toEqual(expect.arrayContaining(['More tools', 'Split view', 'Keep window on top', 'Developer tools']))
    expect(await rowLabels(menu)).not.toContain('New tab')
    await shoot(app, chrome, menu, 'menu-more-tools')

    await menu.locator('.menu-back').click()
    expect(await waitFor(async () => (await rowLabels(menu)).includes('New tab'))).toBe(true)

    // Keyboard: Right drills in, Escape backs out, a second Escape closes.
    await menu.keyboard.press('ArrowDown')
    for (let step = 0; step < 20 && await focusedKey(menu) !== 'sub:More tools'; step += 1) await menu.keyboard.press('ArrowDown')
    expect(await focusedKey(menu)).toBe('sub:More tools')
    await menu.keyboard.press('ArrowRight')
    await menu.waitForSelector('.menu-back')
    expect(await focusedKey(menu)).toBe('cmd:split.toggle')
    await menu.keyboard.press('Escape')
    expect(await waitFor(async () => (await rowLabels(menu)).includes('New tab'))).toBe(true)
    expect(await menuShown(app)).toBe(true)
    expect(await focusedKey(menu)).toBe('sub:More tools')
    await menu.keyboard.press('Escape')
    expect(await waitFor(async () => !(await menuShown(app)))).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('arrow keys move through the rows and Enter runs one; Escape closes and the page has the keys again', async () => {
  const { app, chrome } = await launched(true)
  try {
    const menu = await openMenu(app, chrome)
    expect(await focusedKey(menu)).toBeNull()
    await menu.keyboard.press('ArrowDown')
    expect(await focusedKey(menu)).toBe('cmd:tab.new')
    await menu.keyboard.press('ArrowUp')
    expect(await focusedKey(menu)).toBe('cmd:app.quit')
    await menu.keyboard.press('Home')
    expect(await focusedKey(menu)).toBe('cmd:tab.new')
    await menu.keyboard.press('ArrowDown')
    await shoot(app, chrome, menu, 'menu-focus')
    await menu.keyboard.press('Home')

    await menu.keyboard.press('Enter')
    expect(await waitFor(async () => !(await menuShown(app)))).toBe(true)
    expect(await waitFor(async () => (await tabIds(chrome)).length === 2)).toBe(true)

    await delay(350)
    const again = await openMenu(app, chrome)
    await again.keyboard.press('Escape')
    expect(await waitFor(async () => !(await menuShown(app)))).toBe(true)
    // Focus went back to what had it: a tab's page, not the menu.
    expect(await waitFor(async () => await app.evaluate(({ webContents }) => {
      const focused = webContents.getFocusedWebContents()
      return focused !== null && !focused.getURL().includes('overlay=')
    }))).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('a resize closes the menu; a check entry reflects the window and runs from the submenu', async () => {
  const { app, chrome } = await launched(true)
  try {
    const menu = await openMenu(app, chrome)
    await app.evaluate(({ BaseWindow }) => { const [win] = BaseWindow.getAllWindows(); win?.setSize(1000, 700) })
    expect(await waitFor(async () => !(await menuShown(app)))).toBe(true)
    await delay(350)

    const reopened = await openMenu(app, chrome)
    expect(reopened).toBe(menu)
    await reopened.locator('.menu-row', { hasText: 'More tools' }).click()
    const row = reopened.locator('.menu-row', { hasText: 'Keep window on top' })
    expect(await row.getAttribute('aria-checked')).toBe('false')
    await row.click()
    expect(await waitFor(async () => !(await menuShown(app)))).toBe(true)
    expect(await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]?.isAlwaysOnTop())).toBe(true)

    await delay(350)
    const third = await openMenu(app, chrome)
    await third.locator('.menu-row', { hasText: 'More tools' }).click()
    expect(await third.locator('.menu-row', { hasText: 'Keep window on top' }).getAttribute('aria-checked')).toBe('true')
    await shoot(app, chrome, third, 'menu-check')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('a browser shortcut pressed inside the menu runs on its window, and the new tab dismisses the menu', async () => {
  const { app, chrome } = await launched(true)
  try {
    await openMenu(app, chrome)
    await pressKey(app, 'overlay=menu', 'T', ['control'])
    expect(await waitFor(async () => (await tabIds(chrome)).length === 2)).toBe(true)
    expect(await waitFor(async () => !(await menuShown(app)))).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
