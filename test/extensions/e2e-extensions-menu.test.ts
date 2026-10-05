// The Extensions button and its menu end to end: the button shows by setting, the menu lists every enabled
// extension, pinning moves an extension on and off the toolbar (and what chrome.action.getUserSettings
// answers), a row runs the extension from the menu, the keyboard operates all of it, the right-click menu of
// a toolbar icon is Orivon's, and the choice survives a restart.
//
// Set ORIVON_SHOTS_DIR to also write screenshots of each surface in both colour schemes.
import { afterAll, expect, it } from 'vitest'
import { mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, closeElectron, launchElectron, profileDirOf } from '../support/launch-electron.mjs'
import { delay, evaluateRetrying, findChrome, HERMETIC_RESOLVER, popoverShown, waitFor } from '../support/smoke-helpers.mjs'
import { openExtensionPage, rpc, seedFixture, waitRecovered } from './extensions-e2e-helpers.js'

const SHOTS = process.env['ORIVON_SHOTS_DIR']
const TEST_TIMEOUT_MS = 240_000
const POPUP_NAME = 'Orivon E2E Action Popup'
const SWEEP_NAME = 'Orivon E2E API Sweep'

afterAll(async () => { expect(await assertNoElectronSurvivors()).toEqual([]) })

async function shoot (pages: Page[], name: string, clip?: { x: number, y: number, width: number, height: number }): Promise<void> {
  if (SHOTS === undefined) return
  mkdirSync(SHOTS, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    for (const page of pages) await page.emulateMedia({ colorScheme: scheme })
    await delay(300)
    await pages[0]?.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`), ...(clip === undefined ? {} : { clip }) })
  }
  for (const page of pages) await page.emulateMedia({ colorScheme: null })
}

const overlayOf = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().includes('overlay=extensions-menu'))
const menuShown = async (app: ElectronApplication): Promise<boolean> => await popoverShown(app, 'overlay=extensions-menu')

async function launched (options: { seed?: (dir: string) => void | Promise<void>, args?: string[], reuseProfile?: string }): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER, ...(options.args ?? [])],
    sandbox: true,
    ...(options.reuseProfile === undefined ? {} : { reuseProfile: options.reuseProfile }),
    ...(options.seed === undefined ? {} : { seedProfile: async (dir: string) => { await options.seed?.(dir) } })
  })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

/** The ids of the toolbar's own icons (<browser-action-list>'s shadow DOM). */
const toolbarIds = async (chrome: Page): Promise<string[]> => await evaluateRetrying(chrome, () =>
  Array.from(document.querySelector('browser-action-list')?.shadowRoot?.querySelectorAll('.action') ?? []).map((el) => el.id))

const buttonShown = async (chrome: Page): Promise<boolean> => await evaluateRetrying(chrome, () => {
  const button = document.getElementById('extensions-menu-btn')
  return button !== null && !button.hidden && button.getBoundingClientRect().width > 0
})

async function openMenu (app: ElectronApplication, chrome: Page): Promise<Page> {
  await chrome.click('#extensions-menu-btn')
  expect(await waitFor(async () => await menuShown(app))).toBe(true)
  expect(await waitFor(() => overlayOf(app) !== undefined)).toBe(true)
  const page = overlayOf(app) as Page
  await page.waitForSelector('.em .em-head')
  return page
}

const pinState = async (menu: Page, id: string): Promise<string | null> => await menu.locator(`[data-key="pin:${id}"]`).getAttribute('aria-checked', { timeout: 2_000 }).catch(() => null)

it('lists the extensions, pins and unpins them, runs one from the menu, and keeps the choice across a restart', async () => {
  let popupId = ''
  let sweepId = ''
  const first = await launched({ seed: (dir) => { popupId = seedFixture(dir, 'action-popup'); sweepId = seedFixture(dir, 'api-sweep') } })
  const { app, chrome } = first
  const dir = profileDirOf(app) as string
  try {
    expect(await waitFor(async () => (await app.evaluate(({ session }) => session.defaultSession.extensions.getAllExtensions().length)) === 2)).toBe(true)

    // The button shows, and both extensions are on the toolbar by default.
    expect(await waitFor(async () => await buttonShown(chrome))).toBe(true)
    expect(await waitFor(async () => (await toolbarIds(chrome)).length === 2)).toBe(true)
    expect(await chrome.getAttribute('#extensions-menu-btn', 'aria-haspopup')).toBe('menu')
    await shoot([chrome], 'toolbar-two-pinned', { x: 0, y: 0, width: 1280, height: 104 })

    // The menu: two rows, named, both pinned.
    let menu = await openMenu(app, chrome)
    expect(await menu.locator('.em-row .item-title').allTextContents()).toEqual([POPUP_NAME, SWEEP_NAME])
    expect(await pinState(menu, popupId)).toBe('true')
    expect(await pinState(menu, sweepId)).toBe('true')
    expect(await chrome.getAttribute('#extensions-menu-btn', 'aria-expanded')).toBe('true')
    expect(await menu.locator('.em-manage').textContent()).toContain('Manage extensions')
    await shoot([menu], 'menu-two-rows')

    // More: its lines, and the armed Remove (not clicked a second time).
    await menu.click(`[data-key="more:${popupId}"]`)
    expect(await menu.locator('.em-more-item .item-title').allTextContents()).toEqual(['Options', 'Unpin from toolbar', 'Manage extension', 'Remove from Orivon'])
    await shoot([menu], 'menu-more')
    await menu.click('.em-more-item.danger')
    expect(await menu.locator('.em-more-item.danger .item-title').textContent()).toBe('Click again to remove')
    await shoot([menu], 'menu-remove-armed')
    await menu.keyboard.press('Escape')
    expect(await menu.locator('.em-row').count()).toBe(2)
    expect(await menuShown(app)).toBe(true)

    // Unpinning the sweep takes its icon off the toolbar and getUserSettings says so.
    await menu.click(`[data-key="pin:${sweepId}"]`)
    expect(await waitFor(async () => await pinState(menu, sweepId) === 'false')).toBe(true)
    expect(await waitFor(async () => (await toolbarIds(chrome)).join() === popupId)).toBe(true)
    await waitRecovered(app)
    const page = await openExtensionPage(app, sweepId, 'page.html')
    const settings = await rpc(app, page, 'chrome.action.getUserSettings')
    expect(settings).toEqual({ ok: true, result: { isOnToolbar: false } })
    await shoot([menu], 'menu-one-unpinned')

    // Unpinned, it still runs from its row: the popup opens, the menu is gone and the popup is on screen.
    await menu.click(`[data-key="pin:${popupId}"]`)
    expect(await waitFor(async () => (await toolbarIds(chrome)).length === 0)).toBe(true)
    await menu.click(`[data-key="main:${popupId}"]`)
    const popupOpened = async (): Promise<boolean> => await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().startsWith(`chrome-extension://${id}/popup.html`)), popupId)
    expect(await waitFor(popupOpened)).toBe(true)
    expect(await waitFor(async () => !(await menuShown(app)))).toBe(true)
    const placed = await app.evaluate(({ BrowserWindow }, id) => {
      const popup = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(`chrome-extension://${id}/popup.html`))
      const parent = popup?.getParentWindow()
      return popup === undefined || parent === null || parent === undefined ? null : { popup: popup.getBounds(), parent: parent.getBounds() }
    }, popupId)
    expect(placed).not.toBeNull()
    if (placed !== null) {
      expect(placed.popup.x + placed.popup.width).toBeLessThanOrEqual(placed.parent.x + placed.parent.width + 2)
      expect(placed.popup.x).toBeGreaterThanOrEqual(placed.parent.x - 2)
      expect(placed.popup.y).toBeGreaterThanOrEqual(placed.parent.y)
    }
    expect(await waitFor(async () => !(await menuShown(app)))).toBe(true)
    await delay(800)
    expect(await popupOpened()).toBe(true)
    await app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(`chrome-extension://${id}/popup.html`))?.destroy() }, popupId)

    // The command opens the menu; Down, Right, Enter pin the first row again.
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand('extensions.menu') })
    expect(await waitFor(async () => await menuShown(app))).toBe(true)
    expect(await waitFor(() => overlayOf(app) !== undefined)).toBe(true)
    menu = overlayOf(app) as Page
    await menu.waitForSelector('.em-row')
    await menu.keyboard.press('ArrowDown')
    expect(await menu.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset['key'])).toBe(`main:${popupId}`)
    await menu.keyboard.press('ArrowRight')
    expect(await menu.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset['key'])).toBe(`pin:${popupId}`)
    await menu.keyboard.press('Enter')
    expect(await waitFor(async () => (await toolbarIds(chrome)).join() === popupId)).toBe(true)
    expect(await pinState(menu, popupId)).toBe('true')
    // Right again reaches More, Left comes back, and a letter jumps to the row that starts with it.
    await menu.keyboard.press('ArrowRight')
    expect(await menu.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset['key'])).toBe(`more:${popupId}`)
    await menu.keyboard.press('ArrowLeft')
    await menu.keyboard.press('o')
    expect(await menu.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset['key'])).toMatch(/^main:/)
    await menu.keyboard.press('End')
    expect(await menu.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset['key'])).toBe('manage')
    // The command again closes it; focus is back with the button's window.
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand('extensions.menu') })
    expect(await waitFor(async () => !(await menuShown(app)))).toBe(true)
    expect(await chrome.getAttribute('#extensions-menu-btn', 'aria-expanded')).toBe('false')

    // The right-click menu of a toolbar icon is Orivon's (a native menu: its popup is replaced, never shown).
    await app.evaluate(({ Menu }) => {
      const g = globalThis as { __menus?: unknown[] }
      g.__menus = []
      Menu.prototype.popup = function (this: Electron.Menu) { g.__menus?.push(this) }
    })
    await chrome.click(`#${popupId}`, { button: 'right' })
    expect(await waitFor(async () => await app.evaluate(() => ((globalThis as { __menus?: unknown[] }).__menus ?? []).length > 0))).toBe(true)
    const labels = await app.evaluate(() => ((globalThis as { __menus?: Array<{ items: Array<{ label: string, type: string, enabled: boolean }> }> }).__menus ?? [])[0]?.items.map((item) => (item.type === 'separator' ? '-' : `${item.label}${item.enabled ? '' : ' (off)'}`)))
    expect(labels).toEqual([`${POPUP_NAME} (off)`, '-', 'Options', 'Unpin from Toolbar', 'Manage Extension', 'Remove from Orivon…'])
    await app.evaluate(() => { const menus = (globalThis as { __menus?: Array<{ items: Array<{ label: string, click: () => void }> }> }).__menus ?? []; menus[0]?.items.find((item) => item.label === 'Manage Extension')?.click() })
    expect(await waitFor(() => app.windows().some((w) => w.url().includes(`orivon://extensions/details?id=${popupId}`)))).toBe(true)

    // The pins are on disk before the next launch.
    const prefsFile = join(dir, 'extensions', 'prefs.json')
    const pinnedOnDisk = async (): Promise<unknown> => { try { return (JSON.parse(await readFile(prefsFile, 'utf8')) as { extensions: Record<string, { pinned: boolean }> }).extensions[sweepId]?.pinned } catch { return undefined } }
    expect(await waitFor(async () => await pinnedOnDisk() === false)).toBe(true)
  } finally {
    await closeElectron(app, { keepProfile: true })
  }

  // Next launch: the same pins, and the button hidden by its setting.
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'toolbar.extensions': 'never' } }))
  const second = await launched({ reuseProfile: dir })
  try {
    expect(await waitFor(async () => (await toolbarIds(second.chrome)).join() === popupId)).toBe(true)
    expect(await buttonShown(second.chrome)).toBe(false)
    expect(second.app.windows().some((w) => w.url().includes('overlay=extensions-menu'))).toBe(false)
  } finally {
    await closeElectron(second.app)
  }
}, TEST_TIMEOUT_MS)

it('shows an empty menu with a way to the store when the button is always shown and nothing is installed', async () => {
  const { app, chrome } = await launched({ seed: async (dir) => { await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'toolbar.extensions': 'always' } })) } })
  try {
    expect(await waitFor(async () => await buttonShown(chrome))).toBe(true)
    const menu = await openMenu(app, chrome)
    expect(await menu.locator('.empty-state').textContent()).toContain('Extensions you add appear here.')
    expect(await menu.locator('.empty-state .link-btn').textContent()).toBe('Get extensions from the Chrome Web Store')
    expect(await menu.locator('.em-row').count()).toBe(0)
    await shoot([menu], 'menu-empty')
    // Down reaches the store link, then Manage extensions.
    await menu.keyboard.press('ArrowDown')
    expect(await menu.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset['key'])).toBe('store')
    await menu.click('.em-manage')
    expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://extensions')))).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('has no button in a private window, and none by default without an extension', async () => {
  const withNone = await launched({})
  try {
    await delay(1_000)
    expect(await buttonShown(withNone.chrome)).toBe(false)
  } finally {
    await closeElectron(withNone.app)
  }
  const priv = await launched({ args: ['--orivon-private'], seed: async (dir) => { await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'toolbar.extensions': 'always' } })) } })
  try {
    await delay(1_000)
    expect(await buttonShown(priv.chrome)).toBe(false)
  } finally {
    await closeElectron(priv.app)
  }
}, TEST_TIMEOUT_MS)
