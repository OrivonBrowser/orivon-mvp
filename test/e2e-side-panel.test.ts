// The side panel in the running shell: Mod+Alt+B docks it beside the page (the page area gives up the panel's
// width, nothing is covered), a bookmark opens in the tab, a query filters and a miss says so, History lists the
// pages visited, the setting moves the panel to the other side, the edge resizes by key and by drag and the
// width is remembered, a guest view sits in the body under the popups, a narrow window has no panel, and a
// private window keeps no file. Set ORIVON_UI_SHOTS_DIR to also write screenshots in both colour schemes.
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput, profileDirOf } from './launch-electron.mjs'
import { pressKey } from './e2e-helpers.js'
import { delay, evaluateRetrying, findChrome, HERMETIC_RESOLVER, popoverShown, waitFor, waitForTab } from './smoke-helpers.mjs'

const TEST_TIMEOUT_MS = 180_000
const SHOTS_DIR = process.env.ORIVON_UI_SHOTS_DIR
const SILENT = { args: [HERMETIC_RESOLVER, '--alsa-output-device=null'], env: { PULSE_SERVER: 'unix:/nonexistent' } }

const TITLES: Record<string, string> = {
  one: 'History one', two: 'History two', alpha: 'Alpha page', beta: 'Beta page', bread: 'Bread recipe', soup: 'Soup recipe', gamma: 'Gamma page'
}

let server: Server
let origin = ''

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = (request.url ?? '/').slice(1)
    response.setHeader('content-type', 'text/html')
    response.end(`<!doctype html><title>${TITLES[path] ?? path}</title><p>${path}</p>`)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  if (SHOTS_DIR !== undefined) mkdirSync(SHOTS_DIR, { recursive: true })
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type App = ElectronApplication
const pageUrl = (name: string): string => `${origin}/${name}`

interface Node { id: string, kind: 'url' | 'folder', title: string, url?: string, added: number, children?: Node[] }
const leaf = (name: string): Node => ({ id: `n-${name}`, kind: 'url', title: TITLES[name] ?? name, url: pageUrl(name), added: 1 })

/** A bar with a folder and two pages, and Other bookmarks with one. */
const bookmarksFile = (): string => JSON.stringify({
  version: 2,
  roots: {
    bar: [{ id: 'folder-recipes', kind: 'folder', title: 'Recipes', added: 1, children: [leaf('bread'), leaf('soup')] }, leaf('alpha'), leaf('beta')],
    other: [leaf('gamma')],
    reading: []
  }
})

async function launched (options: { args?: string[], seed?: (dir: string) => Promise<void> } = {}): Promise<{ app: App, chrome: Page }> {
  const app = await launchElectron({
    appPath: '.', ...SILENT, args: [...SILENT.args, ...(options.args ?? [])],
    ...(options.seed === undefined ? {} : { seedProfile: options.seed })
  })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

const panelPageOf = (app: App): Page | undefined => app.windows().find((w) => w.url().includes('overlay=side-panel'))
const menuPageOf = (app: App): Page | undefined => app.windows().find((w) => w.url().includes('overlay=menu'))
const panelShown = async (app: App): Promise<boolean> => await popoverShown(app, 'overlay=side-panel')

async function panel (app: App): Promise<Page> {
  expect(await waitFor(async () => await panelShown(app))).toBe(true)
  expect(await waitFor(() => panelPageOf(app) !== undefined)).toBe(true)
  const page = panelPageOf(app) as Page
  await page.waitForSelector('.sp-input')
  return page
}

/** The window's content width and the bounds of the view whose address holds `part`, read in main. */
async function frameOf (app: App, part: string): Promise<{ window: { width: number, height: number }, view: { x: number, y: number, width: number, height: number } | null }> {
  return await app.evaluate(({ BaseWindow }, wanted) => {
    const win = BaseWindow.getAllWindows()[0]
    if (win === undefined) throw new Error('no window')
    const { width, height } = win.getContentBounds()
    const found = win.contentView.children.find((child) => (child as unknown as { webContents?: { getURL: () => string } }).webContents?.getURL().includes(wanted as string) === true)
    return { window: { width, height }, view: found === undefined ? null : found.getBounds() }
  }, part)
}

/** The page's width settles on `expected`; a miss reports what it was. */
async function expectPageWidth (app: App, tab: string, expected: number): Promise<void> {
  let seen: number | undefined
  const ok = await waitFor(async () => { seen = (await frameOf(app, tab)).view?.width; return seen === expected })
  expect({ ok, seen }).toEqual({ ok: true, seen: expected })
}

async function resizeTo (app: App, width: number, height: number): Promise<void> {
  await app.evaluate(({ BaseWindow }, [w, h]) => { BaseWindow.getAllWindows()[0]?.setSize(w as number, h as number) }, [width, height])
}

type Seam = { host: (i: number) => Record<string, (...args: unknown[]) => unknown>, setSetting: (key: string, value: unknown) => void, setGuestEntries: (entries: unknown) => void, chosen: string[] }

const command = async (chrome: Page, id: string): Promise<void> => {
  await chrome.evaluate((commandId) => { (window as unknown as { orivonShell: { runCommand: (i: string) => void } }).orivonShell.runCommand(commandId) }, id)
}

async function visit (app: App, chrome: Page, name: string): Promise<void> {
  await chrome.evaluate((url) => { (window as unknown as { orivonShell: { newTab: (u: string) => void } }).orivonShell.newTab(url) }, pageUrl(name))
  expect((await waitForTab(chrome, { title: TITLES[name] ?? name })).ok).toBe(true)
  expect(await waitFor(async () => await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().some((wc) => wc.getURL() === url && !wc.isLoading()), pageUrl(name)))).toBe(true)
}

const treeTitles = async (page: Page): Promise<string[]> => await page.locator('.sp-list .tree-label, .sp-list .listbox-item .item-title').allInnerTexts()
const rowTitles = async (page: Page): Promise<string[]> => await page.locator('.sp-list .listbox-item .item-title').allInnerTexts()

async function expectTitles (read: () => Promise<string[]>, expected: string[]): Promise<void> {
  let seen: string[] = []
  const ok = await waitFor(async () => { seen = await read(); return JSON.stringify(seen) === JSON.stringify(expected) })
  expect({ ok, seen }).toEqual({ ok: true, seen: expected })
}

async function shoot (app: App, chrome: Page, page: Page | undefined, name: string): Promise<void> {
  if (SHOTS_DIR === undefined) return
  await chrome.mouse.move(700, 14)
  for (const scheme of ['light', 'dark'] as const) {
    await chrome.emulateMedia({ colorScheme: scheme })
    await page?.emulateMedia({ colorScheme: scheme })
    await delay(400)
    if (page !== undefined && !page.isClosed()) await page.screenshot({ path: join(SHOTS_DIR, `${name}-panel-${scheme}.png`) })
    try { execFileSync('import', ['-window', 'root', join(SHOTS_DIR, `${name}-window-${scheme}.png`)]) } catch { /* no ImageMagick: the panel's own shot stays */ }
  }
  await chrome.emulateMedia({ colorScheme: null })
  await page?.emulateMedia({ colorScheme: null })
}

it('opens beside the page, lists bookmarks, filters, shows history, resizes, remembers, moves sides and holds a guest', async () => {
  const { app, chrome } = await launched({ seed: async (dir) => { await writeFile(join(dir, 'bookmarks.json'), bookmarksFile()) } })
  try {
    await visit(app, chrome, 'one')
    await visit(app, chrome, 'two')
    let tab = pageUrl('two')

    // Closed: the page has the whole width.
    const closed = await frameOf(app, tab)
    expect(closed.view?.width).toBe(closed.window.width)
    expect(await panelShown(app)).toBe(false)

    // Mod+Alt+B opens it, and the page gives up exactly the panel's width.
    await pressKey(app, tab, 'B', ['control', 'alt'])
    const page = await panel(app)
    await expectPageWidth(app, tab, closed.window.width - 360)
    const docked = await frameOf(app, tab)
    expect(docked.view).toMatchObject({ x: 0, width: docked.window.width - 360 })
    expect((await frameOf(app, 'overlay=side-panel')).view).toMatchObject({ x: docked.window.width - 360, width: 360, y: docked.view?.y, height: docked.view?.height })
    await expect.poll(async () => await chrome.getAttribute('#side-panel', 'aria-pressed')).toBe('true')

    // The tree: the bar and Other bookmarks, expanded; folders toggle.
    await expectTitles(() => treeTitles(page), ['Bookmarks bar', 'Recipes', 'Alpha page', 'Beta page', 'Other bookmarks', 'Gamma page'])
    await page.click('.tree-item:has-text("Recipes")')
    await expectTitles(() => treeTitles(page), ['Bookmarks bar', 'Recipes', 'Bread recipe', 'Soup recipe', 'Alpha page', 'Beta page', 'Other bookmarks', 'Gamma page'])
    await shoot(app, chrome, page, 'tree')
    await page.click('.tree-item:has-text("Recipes")')
    await expectTitles(() => treeTitles(page), ['Bookmarks bar', 'Recipes', 'Alpha page', 'Beta page', 'Other bookmarks', 'Gamma page'])

    // A click opens the bookmark in the tab in front.
    await page.click('.tree-item:has-text("Alpha page")')
    expect((await waitForTab(chrome, { title: 'Alpha page' })).ok).toBe(true)
    tab = pageUrl('alpha')

    // A query: one match, then the sentence for none.
    await page.fill('.sp-input', 'beta')
    await expectTitles(() => rowTitles(page), ['Beta page'])
    expect(await page.locator('.sp-list mark').first().innerText()).toBe('Beta')
    await shoot(app, chrome, page, 'matches')
    await page.fill('.sp-input', 'zzz')
    await expect.poll(async () => await page.locator('.empty-state').innerText()).toBe('No bookmarks match "zzz".')
    await shoot(app, chrome, page, 'no-match')

    // Escape clears the query; a second Escape hands the keys to the page.
    await page.keyboard.press('Escape')
    await expectTitles(() => treeTitles(page), ['Bookmarks bar', 'Recipes', 'Alpha page', 'Beta page', 'Other bookmarks', 'Gamma page'])
    expect(await page.inputValue('.sp-input')).toBe('')
    await page.keyboard.press('Escape')
    expect(await waitFor(async () => await app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL() ?? '') === pageUrl('alpha'))).toBe(true)
    expect(await panelShown(app)).toBe(true)

    // History: the pages visited, today.
    await page.click('.sp-picker')
    await page.waitForSelector('.sp-picker-list:not([hidden])')
    await shoot(app, chrome, page, 'picker')
    await page.click('.sp-choice:has-text("History")')
    await expect.poll(async () => await page.locator('.sp-group').allTextContents()).toEqual(['Today'])
    const visited = await rowTitles(page)
    expect(visited).toEqual(expect.arrayContaining(['History one', 'History two']))
    expect(visited.length).toBeGreaterThanOrEqual(2)
    await shoot(app, chrome, page, 'history')

    // The edge: three presses on ArrowLeft widen a right-hand panel from 360 to 408.
    await page.focus('.sp-edge')
    for (let press = 0; press < 3; press += 1) await page.keyboard.press('ArrowLeft')
    await expectPageWidth(app, tab, closed.window.width - 408)
    expect(await page.getAttribute('.sp-edge', 'aria-valuenow')).toBe('408')
    await shoot(app, chrome, page, 'edge-focused')

    // A drag moves the edge with the pointer, 80px into the page.
    const edge = await page.locator('.sp-edge').boundingBox()
    if (edge === null) throw new Error('no edge')
    await page.mouse.move(edge.x + 3, 300)
    await page.mouse.down()
    await page.mouse.move(edge.x + 3 - 80, 300)
    await page.mouse.up()
    await expectPageWidth(app, tab, closed.window.width - 488)

    // A double click puts it back to 360.
    await page.dblclick('.sp-edge')
    await expectPageWidth(app, tab, closed.window.width - 360)
    await page.focus('.sp-edge')
    for (let press = 0; press < 3; press += 1) await page.keyboard.press('ArrowLeft')
    await expectPageWidth(app, tab, closed.window.width - 408)

    // Close: the page is whole again and has the keys; reopen: the width and the view are kept.
    await page.click('.sp-close')
    await expectPageWidth(app, tab, closed.window.width)
    expect(await waitFor(async () => !(await panelShown(app)))).toBe(true)
    expect(await waitFor(async () => await app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getURL() ?? '') === pageUrl('alpha'))).toBe(true)
    await command(chrome, 'sidePanel.toggle')
    await panel(app)
    await expectPageWidth(app, tab, closed.window.width - 408)
    expect(await page.locator('.sp-picker-name').innerText()).toBe('History')

    // The setting moves it to the left: the page starts at the panel's width.
    await app.evaluate(() => { (globalThis as unknown as { __orivonDevSidePanel: Seam }).__orivonDevSidePanel.setSetting('sidePanel.side', 'left') })
    expect(await waitFor(async () => (await frameOf(app, tab)).view?.x === 408)).toBe(true)
    expect((await frameOf(app, 'overlay=side-panel')).view).toMatchObject({ x: 0, width: 408 })
    await shoot(app, chrome, page, 'left')

    // A guest view sits at the body, and the main menu opens above it.
    await app.evaluate(({ WebContentsView }) => {
      const seam = (globalThis as unknown as { __orivonDevSidePanel: Seam }).__orivonDevSidePanel
      const view = new WebContentsView()
      void view.webContents.loadURL('data:text/html,<body style="margin:0;background:%23123"><p style="color:white">guest</p>')
      seam.host(0)['setGuest']?.({ id: 'ext:guestview', title: 'Guest view', view })
    })
    const body = await app.evaluate(() => (globalThis as unknown as { __orivonDevSidePanel: Seam }).__orivonDevSidePanel.host(0)['bodyBounds']?.())
    expect(await waitFor(async () => JSON.stringify((await frameOf(app, 'guest')).view) === JSON.stringify(body))).toBe(true)
    await chrome.click('#menu')
    expect(await waitFor(async () => await popoverShown(app, 'overlay=menu'))).toBe(true)
    const order = await app.evaluate(({ BaseWindow }) => {
      const win = BaseWindow.getAllWindows()[0]
      const urls = win?.contentView.children.map((child) => (child as unknown as { webContents?: { getURL: () => string } }).webContents?.getURL() ?? '') ?? []
      const at = (part: string): number => urls.findIndex((url) => url.includes(part))
      return { panel: at('overlay=side-panel'), guest: at('data:text/html'), menu: at('overlay=menu') }
    })
    expect(order.panel).toBeGreaterThanOrEqual(0)
    expect(order.guest).toBeGreaterThan(order.panel)
    expect(order.menu).toBeGreaterThan(order.guest)
    await menuPageOf(app)?.keyboard.press('Escape').catch(() => {})
    await shoot(app, chrome, page, 'guest')

    // Back on the right with a plain view, then a 700px window has no panel at all.
    await app.evaluate(() => { (globalThis as unknown as { __orivonDevSidePanel: Seam }).__orivonDevSidePanel.setSetting('sidePanel.side', 'right') })
    await command(chrome, 'sidePanel.toggle')
    expect(await waitFor(async () => !(await panelShown(app)))).toBe(true)
    await resizeTo(app, 700, 800)
    expect(await waitFor(async () => (await frameOf(app, tab)).window.width === 700)).toBe(true)
    expect(await waitFor(async () => await evaluateRetrying(chrome, () => (document.querySelector('#side-panel') as HTMLButtonElement | null)?.disabled === true))).toBe(true)
    expect(await chrome.getAttribute('#side-panel', 'title')).toBe('Widen the window to use the side panel')
    await command(chrome, 'sidePanel.toggle')
    await delay(800)
    expect(await panelShown(app)).toBe(false)
    expect((await frameOf(app, tab)).view?.width).toBe(700)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('keeps no file in a private window, says it keeps no history, and shows the empty state', async () => {
  const { app, chrome } = await launched({ args: ['--orivon-private'] })
  try {
    await command(chrome, 'sidePanel.toggle')
    const page = await panel(app)
    await expect.poll(async () => await page.locator('.empty-state').innerText()).toBe('Bookmarks you save appear here.')
    await shoot(app, chrome, page, 'empty')

    await page.click('.sp-picker')
    await page.click('.sp-choice:has-text("History")')
    await expect.poll(async () => await page.locator('.empty-state').innerText()).toBe('Private windows keep no history.')

    await page.focus('.sp-edge')
    await page.keyboard.press('ArrowLeft')
    expect(await page.getAttribute('.sp-edge', 'aria-valuenow')).toBe('376')
    await delay(1200)
    expect(existsSync(join(profileDirOf(app) as string, 'side-panel.json'))).toBe(false)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('remembers the width and the last view in an ordinary profile', async () => {
  const { app, chrome } = await launched()
  try {
    await command(chrome, 'sidePanel.toggle')
    const page = await panel(app)
    await page.click('.sp-picker')
    await page.click('.sp-choice:has-text("Downloads")')
    await page.focus('.sp-edge')
    await page.keyboard.press('ArrowLeft')
    const file = join(profileDirOf(app) as string, 'side-panel.json')
    await expect.poll(async () => existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : null, { timeout: 10_000 }).toEqual({ version: 1, width: 376, view: 'downloads' })
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

const selectedTitle = async (page: Page): Promise<string> => await page.locator('.sp-list [aria-selected="true"] .tree-label, .sp-list [aria-selected="true"] .item-title').first().innerText()

it('is driven from the keyboard: arrows, Right to unfold, Enter and Ctrl+Enter to open, Delete twice to remove', async () => {
  const { app, chrome } = await launched({ seed: async (dir) => { await writeFile(join(dir, 'bookmarks.json'), bookmarksFile()) } })
  try {
    await command(chrome, 'sidePanel.toggle')
    const page = await panel(app)
    await expectTitles(() => treeTitles(page), ['Bookmarks bar', 'Recipes', 'Alpha page', 'Beta page', 'Other bookmarks', 'Gamma page'])
    expect(await page.evaluate(() => document.activeElement?.className)).toContain('sp-input')

    // Down from the field lands on the list, and the list is a tree: Right unfolds a folder.
    await page.keyboard.press('ArrowDown')
    expect(await page.evaluate(() => document.activeElement?.className)).toContain('sp-list')
    expect(await selectedTitle(page)).toBe('Bookmarks bar')
    await page.keyboard.press('ArrowDown')
    expect(await selectedTitle(page)).toBe('Recipes')
    await page.keyboard.press('ArrowRight')
    await expectTitles(() => treeTitles(page), ['Bookmarks bar', 'Recipes', 'Bread recipe', 'Soup recipe', 'Alpha page', 'Beta page', 'Other bookmarks', 'Gamma page'])
    await page.keyboard.press('ArrowRight')
    expect(await selectedTitle(page)).toBe('Bread recipe')

    // Delete asks once, and moving away takes the question back.
    await page.keyboard.press('Delete')
    await expect.poll(async () => await page.locator('.sp-armed').innerText()).toBe('Press Delete again to remove')
    await shoot(app, chrome, page, 'delete-armed')
    await page.keyboard.press('ArrowDown')
    await expect.poll(async () => await page.locator('.sp-armed').count()).toBe(0)
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Delete')
    await page.keyboard.press('Delete')
    await expectTitles(() => treeTitles(page), ['Bookmarks bar', 'Recipes', 'Soup recipe', 'Alpha page', 'Beta page', 'Other bookmarks', 'Gamma page'])
    expect(await selectedTitle(page)).toBe('Soup recipe')

    // Left goes to the parent; Enter opens in the tab in front, Ctrl+Enter behind it.
    await page.keyboard.press('ArrowLeft')
    expect(await selectedTitle(page)).toBe('Recipes')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    expect(await selectedTitle(page)).toBe('Alpha page')
    await page.keyboard.press('Enter')
    expect((await waitForTab(chrome, { title: 'Alpha page' })).ok).toBe(true)
    const before = (await evaluateRetrying(chrome, () => document.querySelectorAll('.tab').length)) as number
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Control+Enter')
    expect(await waitFor(async () => (await evaluateRetrying(chrome, () => document.querySelectorAll('.tab').length)) === before + 1)).toBe(true)
    expect((await waitForTab(chrome, { title: 'Alpha page' })).ok).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
