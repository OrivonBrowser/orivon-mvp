// The bookmarks bar in the running shell: a legacy bookmarks.json migrates to format 2 without loss, a click
// opens the page (a middle click behind the current tab), a folder opens its menu that drills in and out by
// keyboard, what does not fit goes behind a chevron, Mod+Shift+B hides and shows the bar, the right-click
// menu deletes, a drag reorders and files into a folder, and the star follows the active tab.
// Set ORIVON_UI_SHOTS_DIR to also write screenshots in both colour schemes.
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput, profileDirOf } from './launch-electron.mjs'
import { commandById } from '../src/main/shortcuts/commands.js'
import { pressKey } from './e2e-helpers.js'
import { removeThroughBubble } from './bookmark-bubble-helpers.js'
import { bookmarksBarMatches, bookmarkUrls, delay, evaluateRetrying, findChrome, HERMETIC_RESOLVER, popoverShown, tabIds, waitFor, waitForTab } from './smoke-helpers.mjs'

// The menu lists the manager once its command stops being a stub.
const MANAGER_ROW = commandById('bookmarks.open')?.pending === true ? [] : ['Bookmark Manager']

const TEST_TIMEOUT_MS = 120_000
const SHOTS_DIR = process.env.ORIVON_UI_SHOTS_DIR
const SILENT = { args: [HERMETIC_RESOLVER, '--alsa-output-device=null'], env: { PULSE_SERVER: 'unix:/nonexistent' } }

const COLOURS: Array<[number, number, number]> = [[220, 38, 38], [37, 99, 235], [22, 163, 74], [234, 88, 12], [147, 51, 234], [13, 148, 136]]

/** A 16px PNG of one colour, as a data URL the shell accepts and re-encodes. */
function icon (colour: [number, number, number]): string {
  const size = 16
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => colour).flat())])
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const check = Buffer.alloc(4)
    check.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, check])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))), chunk('IEND', Buffer.alloc(0))])
  return `data:image/png;base64,${png.toString('base64')}`
}

let server: Server
let origin = ''

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end(`<!doctype html><title>Page ${request.url ?? ''}</title><p>${request.url ?? ''}</p>`)
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

async function launched (seed?: (dir: string) => Promise<void>): Promise<{ app: App, chrome: Page }> {
  const app = await launchElectron({ appPath: '.', ...SILENT, ...(seed === undefined ? {} : { seedProfile: seed }) })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

/** The bookmarks file as the shell wrote it. */
async function fileOf (app: App): Promise<{ version: number, roots: Record<string, Array<Record<string, unknown>>> }> {
  return JSON.parse(await readFile(join(profileDirOf(app) as string, 'bookmarks.json'), 'utf8')) as never
}

const barTitles = async (chrome: Page): Promise<string[]> => await evaluateRetrying(chrome, () =>
  Array.from(document.querySelectorAll<HTMLElement>('#bookmarks-list .bmitem')).filter((el) => !el.hidden).map((el) => el.getAttribute('aria-label') ?? ''))

const overlayOf = (app: App): Page | undefined => app.windows().find((w) => w.url().includes('overlay=bookmark-folder'))
const folderShown = async (app: App): Promise<boolean> => await popoverShown(app, 'overlay=bookmark-folder')

async function folderPage (app: App): Promise<Page> {
  expect(await waitFor(async () => await folderShown(app))).toBe(true)
  expect(await waitFor(() => overlayOf(app) !== undefined)).toBe(true)
  const page = overlayOf(app) as Page
  await page.waitForSelector('.bmf .bmf-row, .bmf .bmf-empty')
  return page
}

/** A key that closes the overlay ends the page it was sent to: Playwright reports that as an error. */
async function pressClosing (overlay: Page, key: string): Promise<void> {
  await overlay.keyboard.press(key).catch((error: unknown) => { if (!/has been closed/.test(String(error))) throw error })
}

const rowLabels = async (page: Page): Promise<string[]> => await page.locator('.bmf-row .bmf-label').allInnerTexts()

/** The window's own size, for the narrow and the roomy case. */
async function resizeTo (app: App, width: number, height: number): Promise<void> {
  await app.evaluate(({ BaseWindow }, [w, h]) => { BaseWindow.getAllWindows()[0]?.setSize(w as number, h as number) }, [width, height])
}

/** Moves the pointer off every control, so no hover look is in a screenshot. */
async function park (chrome: Page): Promise<void> {
  await chrome.mouse.move(700, 14)
  await delay(150)
}

async function shoot (chrome: Page, name: string, extra?: Page): Promise<void> {
  if (SHOTS_DIR === undefined) return
  for (const scheme of ['light', 'dark'] as const) {
    await chrome.emulateMedia({ colorScheme: scheme })
    await extra?.emulateMedia({ colorScheme: scheme })
    await delay(400)
    await chrome.screenshot({ path: join(SHOTS_DIR, `${name}-${scheme}.png`), clip: { x: 0, y: 0, width: await chrome.evaluate(() => window.innerWidth), height: 104 } })
    if (extra !== undefined && !extra.isClosed()) {
      await extra.screenshot({ path: join(SHOTS_DIR, `${name}-menu-${scheme}.png`) })
      execFileSync('import', ['-window', 'root', join(SHOTS_DIR, `${name}-window-${scheme}.png`)])
    }
  }
  await chrome.emulateMedia({ colorScheme: null })
  await extra?.emulateMedia({ colorScheme: null })
}

const LEGACY = (): string => JSON.stringify([
  { url: pageUrl('one'), title: 'First page', favicon: icon(COLOURS[0] as [number, number, number]) },
  { url: pageUrl('two'), title: 'Second page', favicon: icon(COLOURS[1] as [number, number, number]) },
  { url: pageUrl('three'), title: 'Third page', favicon: null }
])

interface SeedNode { id: string, kind: 'url' | 'folder', title: string, url?: string, favicon?: string, added: number, children?: SeedNode[] }
const page = (id: string, title: string, colour: number, extra: Partial<SeedNode> = {}): SeedNode => ({ id, kind: 'url', title, url: pageUrl(id), favicon: icon(COLOURS[colour % COLOURS.length] as [number, number, number]), added: 1, ...extra })

/** A bar with a folder holding a nested folder, plain pages, and enough more items to overflow a narrow window. */
function tree (extra = 30): string {
  const deep: SeedNode = { id: 'deep0000000', kind: 'folder', title: 'Deep folder', added: 1, children: [page('deepa', 'Deep page', 4)] }
  const work: SeedNode = { id: 'work0000000', kind: 'folder', title: 'Work', added: 1, children: [deep, page('w1', 'Design notes', 1), page('w2', 'Sprint board', 2), page('w3', 'A page whose title is so long that the menu has to cut it short with an ellipsis', 3)] }
  const bar: SeedNode[] = [work, { id: 'empty000000', kind: 'folder', title: 'Empty', added: 1, children: [] }, ...Array.from({ length: extra }, (_, i) => page(`bar${String(i)}`, `Bookmark number ${String(i + 1)}`, i))]
  return JSON.stringify({ version: 2, roots: { bar, other: [], reading: [] } })
}

it('migrates a legacy bookmarks.json to format 2 without loss, opens a click in the tab and a middle click behind it', async () => {
  const { app, chrome } = await launched(async (dir) => { await writeFile(join(dir, 'bookmarks.json'), LEGACY()) })
  try {
    expect(await waitFor(async () => (await barTitles(chrome)).length === 3)).toBe(true)
    expect(await barTitles(chrome)).toEqual(['First page', 'Second page', 'Third page'])
    expect(await bookmarkUrls(chrome)).toEqual([pageUrl('one'), pageUrl('two'), pageUrl('three')])

    expect(await waitFor(async () => { try { return (await fileOf(app)).version === 2 } catch { return false } })).toBe(true)
    const written = await fileOf(app)
    expect(written.roots['bar']?.map((node) => node['title'])).toEqual(['First page', 'Second page', 'Third page'])
    const ids = written.roots['bar']?.map((node) => node['id']) as string[]
    expect(new Set(ids).size).toBe(3)
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(existsSync(join(profileDirOf(app) as string, 'bookmarks.json.bak'))).toBe(true)
    expect(await bookmarksBarMatches(chrome, true)).toBe(true)

    // The new-tab page's tiles still list them.
    const dashboard = (): Page | undefined => app.windows().find((w) => w.url().includes('/newtab/'))
    expect(await waitFor(() => dashboard() !== undefined)).toBe(true)
    expect(await waitFor(async () => await (dashboard() as Page).locator('#bookmarks-grid .tile').count() === 3)).toBe(true)
    expect(await (dashboard() as Page).locator('#bookmarks-grid .tile-label').allInnerTexts()).toEqual(['First page', 'Second page', 'Third page'])
    await shoot(chrome, 'legacy-migrated')

    await chrome.click('#bookmarks-list .bmitem >> nth=0')
    expect((await waitForTab(chrome, { address: pageUrl('one') })).ok).toBe(true)
    const before = await tabIds(chrome)
    await chrome.click('#bookmarks-list .bmitem >> nth=1', { button: 'middle' })
    expect(await waitFor(async () => (await tabIds(chrome)).length === before.length + 1)).toBe(true)
    // Behind: the tab in front is still the first page.
    expect((await waitForTab(chrome, { address: pageUrl('one') })).ok).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('opens a folder menu, drills in and out and opens a page by keyboard, and closes on Escape with the focus back on the folder', async () => {
  const { app, chrome } = await launched(async (dir) => { await writeFile(join(dir, 'bookmarks.json'), tree()) })
  try {
    expect(await waitFor(async () => (await barTitles(chrome)).length > 3)).toBe(true)
    const work = '#bookmarks-list .bmitem[data-id="work0000000"]'

    await chrome.click(work)
    const menu = await folderPage(app)
    expect(await rowLabels(menu)).toEqual(['Deep folder', 'Design notes', 'Sprint board', 'A page whose title is so long that the menu has to cut it short with an ellipsis', 'Open all (3)'])
    expect(await menu.locator('.bmf-row[aria-haspopup="menu"]').count()).toBe(1)
    await park(chrome)
    await shoot(chrome, 'folder-open', menu)

    await menu.keyboard.press('ArrowDown')
    await menu.keyboard.press('ArrowRight')
    expect(await waitFor(async () => (await rowLabels(menu))[0] === 'Deep folder' && await menu.locator('.bmf-back').count() === 1)).toBe(true)
    expect(await rowLabels(menu)).toEqual(['Deep folder', 'Deep page', 'Open all (1)'])
    await menu.keyboard.press('ArrowLeft')
    expect(await waitFor(async () => await menu.locator('.bmf-back').count() === 0)).toBe(true)
    expect(await menu.evaluate(() => document.activeElement?.textContent)).toContain('Deep folder')

    await menu.keyboard.press('ArrowDown')
    await pressClosing(menu, 'Enter')
    expect((await waitForTab(chrome, { address: pageUrl('w1') })).ok).toBe(true)
    expect(await waitFor(async () => !(await folderShown(app)))).toBe(true)

    // Escape closes the menu and the keys are back on the folder that opened it.
    await chrome.click(work)
    await folderPage(app)
    await pressClosing(overlayOf(app) as Page, 'Escape')
    expect(await waitFor(async () => !(await folderShown(app)))).toBe(true)
    expect(await waitFor(async () => await evaluateRetrying(chrome, () => (document.activeElement as HTMLElement | null)?.dataset['id'] === 'work0000000'))).toBe(true)

    // A second click on an open folder closes it; an empty folder says so.
    await chrome.click(work)
    await folderPage(app)
    await chrome.click(work)
    expect(await waitFor(async () => !(await folderShown(app)))).toBe(true)
    await chrome.click('#bookmarks-list .bmitem[data-id="empty000000"]')
    const empty = await folderPage(app)
    expect(await empty.locator('.bmf-empty').innerText()).toBe('(empty)')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('moves what does not fit behind a chevron that lists it, and Mod+Shift+B hides and shows the bar', async () => {
  const { app, chrome } = await launched(async (dir) => { await writeFile(join(dir, 'bookmarks.json'), tree()) })
  try {
    expect(await waitFor(async () => (await barTitles(chrome)).length > 3)).toBe(true)
    await resizeTo(app, 620, 700)
    expect(await waitFor(async () => await chrome.locator('.bmmore:not([hidden])').count() === 1)).toBe(true)
    const shown = (await barTitles(chrome)).length
    expect(shown).toBeGreaterThan(1)
    expect(shown).toBeLessThan(32)

    await park(chrome)
    await chrome.click('.bmmore')
    const menu = await folderPage(app)
    expect((await rowLabels(menu)).length).toBe(32 - shown)
    expect((await rowLabels(menu))[0]).toBe((await chrome.evaluate((n) => Array.from(document.querySelectorAll('#bookmarks-list .bmitem')).map((el) => el.getAttribute('aria-label'))[n], shown)) ?? '')
    expect(await menu.locator('.bmf-all').count()).toBe(0)
    await shoot(chrome, 'overflow', menu)
    await pressClosing(menu, 'Escape')
    expect(await waitFor(async () => !(await folderShown(app)))).toBe(true)

    await resizeTo(app, 1200, 700)
    expect(await waitFor(async () => (await barTitles(chrome)).length > shown)).toBe(true)

    // Mod+Shift+B: the bar goes, the chrome shrinks and the page area follows; again and it comes back.
    const tabTop = async (): Promise<number> => await app.evaluate(({ BaseWindow }) => {
      const view = BaseWindow.getAllWindows()[0]?.contentView.children.find((child) => (child as unknown as { webContents?: { getURL: () => string } }).webContents?.getURL().startsWith('orivon://newtab') === true || (child as unknown as { webContents?: { getURL: () => string } }).webContents?.getURL().includes('/newtab/') === true)
      return view?.getBounds().y ?? -1
    })
    expect(await bookmarksBarMatches(chrome, true)).toBe(true)
    expect(await tabTop()).toBe(104)
    await pressKey(app, '/newtab/', 'B', ['control', 'shift'])
    expect(await waitFor(async () => await bookmarksBarMatches(chrome, false))).toBe(true)
    expect(await waitFor(async () => await tabTop() === 76)).toBe(true)
    await pressKey(app, '/newtab/', 'B', ['control', 'shift'])
    expect(await waitFor(async () => await bookmarksBarMatches(chrome, true))).toBe(true)
    expect(await waitFor(async () => await tabTop() === 104)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('shows an empty bar with a hint while the setting asks for it', async () => {
  const { app, chrome } = await launched(async (dir) => {
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'appearance.bookmarksBar': 'always' } }))
  })
  try {
    expect(await waitFor(async () => await bookmarksBarMatches(chrome, true))).toBe(true)
    expect(await chrome.locator('.bmempty').innerText()).toBe('Bookmark a page with the star to see it here.')
    await shoot(chrome, 'empty')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('walks the bar with the arrow keys, Home and End, and opens the focused item with Enter', async () => {
  const { app, chrome } = await launched(async (dir) => { await writeFile(join(dir, 'bookmarks.json'), LEGACY()) })
  try {
    expect(await waitFor(async () => (await barTitles(chrome)).length === 3)).toBe(true)
    const focused = async (): Promise<string | null> => await evaluateRetrying(chrome, () => document.activeElement?.getAttribute('aria-label') ?? null)
    // One Tab stop: exactly one item is reachable by Tab.
    expect(await chrome.locator('#bookmarks-list .bmitem[tabindex="0"]').count()).toBe(1)

    await chrome.focus('#bookmarks-list .bmitem >> nth=0')
    await chrome.keyboard.press('ArrowRight')
    expect(await focused()).toBe('Second page')
    await chrome.keyboard.press('End')
    expect(await focused()).toBe('Third page')
    await chrome.keyboard.press('ArrowRight')
    expect(await focused()).toBe('Third page')
    await chrome.keyboard.press('Home')
    expect(await focused()).toBe('First page')
    await chrome.keyboard.press('Enter')
    expect((await waitForTab(chrome, { address: pageUrl('one') })).ok).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('offers the right-click menus and deletes from them', async () => {
  const { app, chrome } = await launched(async (dir) => { await writeFile(join(dir, 'bookmarks.json'), tree(3)) })
  try {
    expect(await waitFor(async () => (await barTitles(chrome)).length === 5)).toBe(true)
    await app.evaluate(({ Menu }) => { (Menu.prototype as unknown as { popup: () => void }).popup = function (this: unknown) { (globalThis as unknown as { __menu: unknown }).__menu = this } })
    const labels = async (): Promise<string[]> => await app.evaluate(() => ((globalThis as unknown as { __menu?: { items: Array<{ label: string, type: string }> } }).__menu?.items ?? []).map((item) => item.type === 'separator' ? '-' : item.label))
    const choose = async (label: string): Promise<void> => { await app.evaluate((_, l) => { ((globalThis as unknown as { __menu: { items: Array<{ label: string, click: () => void }> } }).__menu.items.find((item) => item.label === l))?.click() }, label) }
    const reset = async (): Promise<void> => { await app.evaluate(() => { (globalThis as unknown as { __menu?: unknown }).__menu = undefined }) }

    await chrome.click('#bookmarks-list .bmitem[data-id="bar1"]', { button: 'right' })
    expect(await waitFor(async () => (await labels()).length > 0)).toBe(true)
    expect(await labels()).toEqual(['Open in New Tab', 'Open in New Window', 'Open in Private Window', '-', 'Edit…', 'Copy Link', 'Delete', '-', 'Add Folder…', '-', 'Show Bookmarks Bar', ...MANAGER_ROW])
    const before = await tabIds(chrome)
    await choose('Open in New Tab')
    expect(await waitFor(async () => (await tabIds(chrome)).length === before.length + 1)).toBe(true)

    await reset()
    await chrome.click('#bookmarks-list .bmitem[data-id="work0000000"]', { button: 'right' })
    expect(await waitFor(async () => (await labels()).length > 0)).toBe(true)
    expect(await labels()).toEqual(['Open All (3)', '-', 'Rename…', 'Delete', '-', 'Add Folder…', '-', 'Show Bookmarks Bar', ...MANAGER_ROW])

    await reset()
    await chrome.mouse.click(900, 90, { button: 'right' })
    expect(await waitFor(async () => (await labels()).length > 0)).toBe(true)
    expect(await labels()).toEqual(['Add Folder…', '-', 'Show Bookmarks Bar', ...MANAGER_ROW])

    await reset()
    await chrome.click('#bookmarks-list .bmitem[data-id="bar1"]', { button: 'right' })
    await waitFor(async () => (await labels()).includes('Delete'))
    await choose('Delete')
    expect(await waitFor(async () => (await barTitles(chrome)).length === 4)).toBe(true)
    expect(await barTitles(chrome)).not.toContain('Bookmark number 2')
    expect(await waitFor(async () => !JSON.stringify(await fileOf(app).catch(() => ({}))).includes('bar1'))).toBe(true)

    // Delete on a folder takes what is in it.
    await reset()
    await chrome.click('#bookmarks-list .bmitem[data-id="work0000000"]', { button: 'right' })
    await waitFor(async () => (await labels()).includes('Delete'))
    await choose('Delete')
    expect(await waitFor(async () => (await barTitles(chrome)).length === 3)).toBe(true)
    expect(await waitFor(async () => !JSON.stringify(await fileOf(app).catch(() => ({}))).includes('Design notes'))).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('reorders by dragging, files an item into a folder, and leaves the order alone on Escape', async () => {
  const { app, chrome } = await launched(async (dir) => { await writeFile(join(dir, 'bookmarks.json'), tree(3)) })
  try {
    expect(await waitFor(async () => (await barTitles(chrome)).length === 5)).toBe(true)
    const box = async (id: string): Promise<{ x: number, y: number, width: number, height: number }> =>
      await chrome.locator(`#bookmarks-list .bmitem[data-id="${id}"]`).evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })
    const order = async (): Promise<string[]> => await barTitles(chrome)
    const start = await order()

    // Escape during a drag changes nothing, and the release does not click the item.
    const first = await box('bar0')
    await chrome.mouse.move(first.x + first.width / 2, first.y + first.height / 2)
    await chrome.mouse.down()
    await chrome.mouse.move(first.x + first.width + 120, first.y + first.height / 2, { steps: 6 })
    expect(await chrome.locator('.bmdropmark:not([hidden])').count()).toBe(1)
    await shoot(chrome, 'drag')
    await chrome.keyboard.press('Escape')
    await chrome.mouse.up()
    await delay(300)
    expect(await order()).toEqual(start)
    expect(await tabIds(chrome)).toHaveLength(1)

    // bar0 goes after bar2.
    const last = await box('bar2')
    await chrome.mouse.move(first.x + first.width / 2, first.y + first.height / 2)
    await chrome.mouse.down()
    await chrome.mouse.move(last.x + last.width - 4, last.y + last.height / 2, { steps: 8 })
    await chrome.mouse.up()
    expect(await waitFor(async () => JSON.stringify((await order()).slice(2)) === JSON.stringify(['Bookmark number 2', 'Bookmark number 3', 'Bookmark number 1']))).toBe(true)
    expect(await tabIds(chrome)).toHaveLength(1)
    expect(await waitFor(async () => (await fileOf(app)).roots['bar']?.map((node) => node['id']).join() === ['work0000000', 'empty000000', 'bar1', 'bar2', 'bar0'].join())).toBe(true)

    // bar1 goes into the Empty folder.
    const dragged = await box('bar1')
    const folder = await box('empty000000')
    await chrome.mouse.move(dragged.x + dragged.width / 2, dragged.y + dragged.height / 2)
    await chrome.mouse.down()
    await chrome.mouse.move(folder.x + folder.width / 2, folder.y + folder.height / 2, { steps: 8 })
    expect(await chrome.locator('.bmitem.drop-into').count()).toBe(1)
    await chrome.mouse.up()
    expect(await waitFor(async () => (await barTitles(chrome)).length === 4)).toBe(true)
    await chrome.click('#bookmarks-list .bmitem[data-id="empty000000"]')
    const menu = await folderPage(app)
    expect(await rowLabels(menu)).toEqual(['Bookmark number 2', 'Open all (1)'])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('marks the star from the store, follows the active tab, and unstars the page', async () => {
  const { app, chrome } = await launched(async (dir) => { await writeFile(join(dir, 'bookmarks.json'), tree(0)) })
  try {
    const visit = async (name: string): Promise<void> => {
      await chrome.evaluate((url) => { (window as unknown as { orivonShell: { newTab: (u: string) => void } }).orivonShell.newTab(url) }, pageUrl(name))
      expect((await waitForTab(chrome, { address: pageUrl(name) })).ok).toBe(true)
    }
    await visit('starred')
    expect((await waitForTab(chrome, { bookmarked: false })).ok).toBe(true)
    await chrome.click('#bookmark-toggle')
    expect((await waitForTab(chrome, { bookmarked: true })).ok).toBe(true)
    expect(await waitFor(async () => (await fileOf(app)).roots['bar']?.some((node) => node['url'] === pageUrl('starred')) === true)).toBe(true)

    await visit('elsewhere')
    expect((await waitForTab(chrome, { bookmarked: false })).ok).toBe(true)
    await chrome.click(`.tab[data-id="${(await tabIds(chrome))[1] as string}"]`)
    expect((await waitForTab(chrome, { address: pageUrl('starred'), bookmarked: true })).ok).toBe(true)

    // The star on a starred page opens the bubble, and its Remove takes the bookmark off.
    await removeThroughBubble(app, chrome)
    expect((await waitForTab(chrome, { bookmarked: false })).ok).toBe(true)
    expect(await waitFor(async () => (await fileOf(app)).roots['bar']?.every((node) => node['url'] !== pageUrl('starred')) === true)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
