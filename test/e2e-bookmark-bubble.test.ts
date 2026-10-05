// The bookmark bubble and "Bookmark all tabs" in the running shell: the star and Mod+D save a page and open the
// bubble under the star, a rename and a folder change are saved as they are made, Remove empties the star, the
// star on a saved page never removes it, a new folder is made from the bubble, "Bookmark all tabs" saves a
// dated folder of the tabs that have a site, and the bar's menu renames a folder and adds one.
// Set ORIVON_UI_SHOTS_DIR to also write screenshots in both colour schemes.
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput, profileDirOf } from './support/launch-electron.mjs'
import { pressKey } from './support/e2e-helpers.js'
import { ALL_TABS, closing, EDIT, overlayOpen, overlayPage } from './support/bookmark-bubble-helpers.js'
import { delay, evaluateRetrying, findChrome, HERMETIC_RESOLVER, tabIds, waitFor, waitForTab } from './support/smoke-helpers.mjs'

const TEST_TIMEOUT_MS = 120_000
const SHOTS_DIR = process.env.ORIVON_UI_SHOTS_DIR
const SILENT = { args: [HERMETIC_RESOLVER, '--alsa-output-device=null'], env: { PULSE_SERVER: 'unix:/nonexistent' } }
const WORK = 'work0000000'

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
interface FileNode { id: string, kind: string, title: string, url?: string, children?: FileNode[] }
const pageUrl = (name: string): string => `${origin}/${name}`

/** A bar holding one folder, "Work", with nothing in it. */
const SEED = JSON.stringify({ version: 2, roots: { bar: [{ id: WORK, kind: 'folder', title: 'Work', added: 1, children: [] }], other: [], reading: [] } })

async function launched (seed: string = SEED): Promise<{ app: App, chrome: Page }> {
  const app = await launchElectron({ appPath: '.', ...SILENT, seedProfile: async (dir) => { await writeFile(join(dir, 'bookmarks.json'), seed) } })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

async function fileOf (app: App): Promise<{ bar: FileNode[], other: FileNode[] }> {
  const parsed = JSON.parse(await readFile(join(profileDirOf(app) as string, 'bookmarks.json'), 'utf8')) as { roots: { bar: FileNode[], other: FileNode[] } }
  return parsed.roots
}

/** The file once `condition` holds of it (writes are debounced), or the last one read. */
async function fileWhere (app: App, condition: (roots: { bar: FileNode[], other: FileNode[] }) => boolean): Promise<boolean> {
  return await waitFor(async () => { try { return condition(await fileOf(app)) } catch { return false } })
}

const work = (roots: { bar: FileNode[] }): FileNode | undefined => roots.bar.find((node) => node.id === WORK)

async function visit (chrome: Page, name: string): Promise<void> {
  await chrome.evaluate((url) => { (window as unknown as { orivonShell: { newTab: (u: string) => void } }).orivonShell.newTab(url) }, pageUrl(name))
  expect((await waitForTab(chrome, { address: pageUrl(name) })).ok).toBe(true)
}

/** A key on the tab in front, through the browser process as a keyboard sends it. */
const key = async (app: App, name: string, code: string, modifiers: string[]): Promise<void> => { await pressKey(app, pageUrl(name), code, modifiers) }

const barTitles = async (chrome: Page): Promise<string[]> => await evaluateRetrying(chrome, () =>
  Array.from(document.querySelectorAll<HTMLElement>('#bookmarks-list .bmitem')).filter((el) => !el.hidden).map((el) => el.getAttribute('aria-label') ?? ''))

/** Every native menu the shell pops up is kept instead of shown. */
async function captureMenus (app: App): Promise<{ labels: () => Promise<string[]>, choose: (label: string) => Promise<void>, reset: () => Promise<void> }> {
  await app.evaluate(({ Menu }) => { (Menu.prototype as unknown as { popup: () => void }).popup = function (this: unknown) { (globalThis as unknown as { __menu: unknown }).__menu = this } })
  return {
    labels: async () => await app.evaluate(() => ((globalThis as unknown as { __menu?: { items: Array<{ label: string, type: string }> } }).__menu?.items ?? []).map((item) => item.type === 'separator' ? '-' : item.label)),
    choose: async (label) => { await app.evaluate((_, l) => { ((globalThis as unknown as { __menu: { items: Array<{ label: string, click: () => void }> } }).__menu.items.find((item) => item.label === l))?.click() }, label) },
    reset: async () => { await app.evaluate(() => { (globalThis as unknown as { __menu?: unknown }).__menu = undefined }) }
  }
}

/** The overlay view's bounds in window pixels. */
async function overlayBounds (app: App, name: string): Promise<{ x: number, y: number, width: number, height: number } | undefined> {
  return await app.evaluate(({ BaseWindow }, part) => {
    for (const window of BaseWindow.getAllWindows()) {
      for (const view of window.contentView.children) {
        const contents = (view as unknown as { webContents?: { getURL: () => string } }).webContents
        if (contents?.getURL().includes(part)) return (view as unknown as { getBounds: () => { x: number, y: number, width: number, height: number } }).getBounds()
      }
    }
    return undefined
  }, `overlay=${name}`)
}

async function shoot (app: App, name: string, chrome: Page, overlay: Page): Promise<void> {
  if (SHOTS_DIR === undefined) return
  for (const scheme of ['light', 'dark'] as const) {
    await chrome.emulateMedia({ colorScheme: scheme })
    await overlay.emulateMedia({ colorScheme: scheme })
    await delay(400)
    await overlay.screenshot({ path: join(SHOTS_DIR, `${name}-${scheme}.png`) })
    execFileSync('import', ['-window', 'root', join(SHOTS_DIR, `${name}-window-${scheme}.png`)])
  }
  await chrome.emulateMedia({ colorScheme: null })
  await overlay.emulateMedia({ colorScheme: null })
  void app
}

it('saves a page from the star and Mod+D, edits its name and folder as they change, removes it only by Remove, and makes a new folder', async () => {
  const { app, chrome } = await launched()
  try {
    await visit(chrome, 'a')

    // The star saves the page in the bar, opens the bubble under itself, and a second click closes it again.
    await chrome.click('#bookmark-toggle')
    let bubble = await overlayPage(app)
    expect(await bubble.locator('.sheet-title').innerText()).toBe('Bookmark added')
    expect((await waitForTab(chrome, { bookmarked: true })).ok).toBe(true)
    expect(await bubble.locator('input[aria-label="Name"]').inputValue()).toBe(`Page /a`)
    expect(await bubble.locator('select[aria-label="Folder"]').inputValue()).toBe('bar')
    const star = await chrome.locator('#bookmark-toggle').boundingBox()
    const at = await overlayBounds(app, EDIT)
    expect(at?.width).toBe(320)
    expect(Math.abs((at?.x ?? 0) - (star?.x ?? 0))).toBeLessThanOrEqual(4)
    expect(at?.y ?? 0).toBeGreaterThanOrEqual((star?.y ?? 0) + (star?.height ?? 0) - 4)
    const options = await bubble.locator('select[aria-label="Folder"] option').allInnerTexts()
    expect(options.map((text) => text.replace(/ /g, '_'))).toEqual(['Bookmarks bar', '__Work', 'Other bookmarks', 'New folder…'])
    await shoot(app, 'added', chrome, bubble)
    await chrome.click('#bookmark-toggle')
    expect(await waitFor(async () => !(await overlayOpen(app)))).toBe(true)
    expect((await waitForTab(chrome, { bookmarked: true })).ok).toBe(true)

    // The star's save is on disk (writes are debounced) before Mod+D is pressed.
    expect(await fileWhere(app, (roots) => roots.bar.filter((node) => node.url !== undefined).length === 1)).toBe(true)

    // Mod+D on the saved page opens "Edit bookmark" and changes nothing; a new name and Enter renames it.
    await key(app, 'a', 'D', ['control'])
    bubble = await overlayPage(app)
    expect(await bubble.locator('.sheet-title').innerText()).toBe('Edit bookmark')
    expect((await fileOf(app)).bar.filter((node) => node.url !== undefined)).toHaveLength(1)
    await bubble.fill('input[aria-label="Name"]', 'Renamed')
    await closing(async () => await bubble.keyboard.press('Enter'))
    expect(await waitFor(async () => !(await overlayOpen(app)))).toBe(true)
    expect(await waitFor(async () => (await barTitles(chrome)).includes('Renamed'))).toBe(true)
    expect(await fileWhere(app, (roots) => roots.bar.some((node) => node.title === 'Renamed'))).toBe(true)

    // The folder select: a keyboard choice is saved at once, and moves the item out of the bar's top level.
    await key(app, 'a', 'D', ['control'])
    bubble = await overlayPage(app)
    await shoot(app, 'edit', chrome, bubble)
    await bubble.selectOption('select[aria-label="Folder"]', WORK)
    expect(await fileWhere(app, (roots) => work(roots)?.children?.some((node) => node.url === pageUrl('a')) === true && roots.bar.every((node) => node.url === undefined))).toBe(true)
    expect(await overlayOpen(app)).toBe(true)

    // Remove takes this bookmark off and empties the star.
    await closing(async () => await bubble.click('.btn.remove'))
    expect((await waitForTab(chrome, { bookmarked: false })).ok).toBe(true)
    expect(await fileWhere(app, (roots) => work(roots)?.children?.length === 0)).toBe(true)

    // Saved again, it goes to the folder used last (Work), and the bubble can make a folder.
    await key(app, 'a', 'D', ['control'])
    bubble = await overlayPage(app)
    expect(await bubble.locator('.sheet-title').innerText()).toBe('Bookmark added')
    expect(await bubble.locator('select[aria-label="Folder"]').inputValue()).toBe(WORK)
    await bubble.selectOption('select[aria-label="Folder"]', '__new__')
    await bubble.waitForSelector('input[aria-label="Folder name"]')
    expect(await bubble.locator('select').count()).toBe(0)
    await bubble.fill('input[aria-label="Folder name"]', 'Fresh')
    await shoot(app, 'new-folder', chrome, bubble)
    await closing(async () => await bubble.keyboard.press('Enter'))
    expect(await fileWhere(app, (roots) => {
      const fresh = work(roots)?.children?.find((node) => node.title === 'Fresh')
      return fresh?.kind === 'folder' && fresh.children?.[0]?.url === pageUrl('a')
    })).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('keeps what was typed when the bubble is dismissed, and leaves the bookmark where it is', async () => {
  const { app, chrome } = await launched()
  try {
    await visit(chrome, 'a')
    await key(app, 'a', 'D', ['control'])
    const bubble = await overlayPage(app)
    await bubble.fill('input[aria-label="Name"]', 'Typed then dismissed')
    await closing(async () => await bubble.keyboard.press('Escape'))
    expect(await waitFor(async () => !(await overlayOpen(app)))).toBe(true)
    expect(await fileWhere(app, (roots) => roots.bar.some((node) => node.title === 'Typed then dismissed'))).toBe(true)
    expect((await waitForTab(chrome, { bookmarked: true })).ok).toBe(true)

    // Clicking away does the same.
    await key(app, 'a', 'D', ['control'])
    const again = await overlayPage(app)
    await again.fill('input[aria-label="Name"]', 'Typed then clicked away')
    // Focus moving to the page is what clicking away is to the overlay: it blurs, and the host closes it.
    await app.evaluate(({ webContents }, part) => { webContents.getAllWebContents().find((wc) => wc.getURL().includes(part))?.focus() }, pageUrl('a'))
    expect(await waitFor(async () => !(await overlayOpen(app)))).toBe(true)
    expect(await fileWhere(app, (roots) => roots.bar.some((node) => node.title === 'Typed then clicked away'))).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('picks a folder with the mouse without the bubble closing under the select', async () => {
  const { app, chrome } = await launched()
  try {
    await visit(chrome, 'a')
    await key(app, 'a', 'D', ['control'])
    const bubble = await overlayPage(app)
    await bubble.click('select[aria-label="Folder"]')
    await delay(800)
    expect(await overlayOpen(app)).toBe(true)
    // A key moves the choice and Enter takes it, whether the list is drawn open or the select is closed.
    await bubble.keyboard.press('ArrowDown')
    await closing(async () => await bubble.keyboard.press('Enter'))
    expect(await fileWhere(app, (roots) => work(roots)?.children?.some((node) => node.url === pageUrl('a')) === true)).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('bookmarks all tabs into a dated folder in strip order, skipping the new-tab page, and only when Save is pressed', async () => {
  const { app, chrome } = await launched()
  try {
    // Nothing has a site yet: the command does nothing.
    expect(await waitFor(async () => (await tabIds(chrome)).length > 0)).toBe(true)
    const first = (await tabIds(chrome))[0] as string
    expect(first).toBeDefined()
    await pressKey(app, '/newtab/', 'D', ['control', 'shift'])
    await delay(600)
    expect(await overlayOpen(app, ALL_TABS)).toBe(false)

    await visit(chrome, 'a')
    await visit(chrome, 'b')
    expect((await tabIds(chrome)).length).toBe(3)
    const name = await app.evaluate(() => `Tabs from ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}`)

    await key(app, 'b', 'D', ['control', 'shift'])
    let sheet = await overlayPage(app, ALL_TABS)
    expect(await sheet.locator('.sheet-title').innerText()).toBe('Bookmark all tabs')
    expect(await sheet.locator('.bme-count').innerText()).toBe('2 tabs in this window')
    expect(await sheet.locator('input[aria-label="Folder name"]').inputValue()).toBe(name)
    expect(await sheet.locator('select[aria-label="Save in"]').inputValue()).toBe('bar')
    await shoot(app, 'all-tabs', chrome, sheet)

    // Escape creates nothing.
    await closing(async () => await sheet.keyboard.press('Escape'))
    expect(await waitFor(async () => !(await overlayOpen(app, ALL_TABS)))).toBe(true)
    await delay(800)
    expect((await fileOf(app)).bar.map((node) => node.title)).toEqual(['Work'])

    await key(app, 'b', 'D', ['control', 'shift'])
    sheet = await overlayPage(app, ALL_TABS)
    await closing(async () => await sheet.keyboard.press('Enter'))
    expect(await fileWhere(app, (roots) => roots.bar.some((node) => node.title === name))).toBe(true)
    const folder = (await fileOf(app)).bar.find((node) => node.title === name) as FileNode
    expect(folder.children?.map((node) => node.url)).toEqual([pageUrl('a'), pageUrl('b')])
    expect(folder.children?.map((node) => node.title)).toEqual(['Page /a', 'Page /b'])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('offers Edit…, Rename… and Add Folder… in the bar menu and opens the bubble for each', async () => {
  const seed = JSON.stringify({ version: 2, roots: { bar: [
    { id: WORK, kind: 'folder', title: 'Work', added: 1, children: [] },
    { id: 'page0000001', kind: 'url', title: 'Saved page', url: pageUrl('saved'), added: 1 }
  ], other: [], reading: [] } })
  const { app, chrome } = await launched(seed)
  try {
    expect(await waitFor(async () => (await barTitles(chrome)).length === 2)).toBe(true)
    const menu = await captureMenus(app)

    await chrome.click(`#bookmarks-list .bmitem[data-id="${WORK}"]`, { button: 'right' })
    expect(await waitFor(async () => (await menu.labels()).includes('Rename…'))).toBe(true)
    await menu.choose('Rename…')
    let sheet = await overlayPage(app)
    expect(await sheet.locator('.sheet-title').innerText()).toBe('Rename folder')
    expect(await sheet.locator('select').count()).toBe(0)
    expect(await sheet.locator('input[aria-label="Name"]').inputValue()).toBe('Work')
    await shoot(app, 'folder-mode', chrome, sheet)
    await sheet.fill('input[aria-label="Name"]', 'Jobs')
    await closing(async () => await sheet.click('.btn.primary'))
    expect(await fileWhere(app, (roots) => roots.bar.some((node) => node.id === WORK && node.title === 'Jobs'))).toBe(true)
    expect(await waitFor(async () => (await barTitles(chrome)).includes('Jobs'))).toBe(true)

    // Cancel leaves the name alone.
    await menu.reset()
    await chrome.click(`#bookmarks-list .bmitem[data-id="${WORK}"]`, { button: 'right' })
    await waitFor(async () => (await menu.labels()).includes('Rename…'))
    await menu.choose('Rename…')
    sheet = await overlayPage(app)
    await sheet.fill('input[aria-label="Name"]', 'Never saved')
    await closing(async () => await sheet.click('.btn:not(.primary)'))
    await delay(600)
    expect((await fileOf(app)).bar[0]?.title).toBe('Jobs')

    // Edit… on a page opens its bubble, under the item.
    await menu.reset()
    await chrome.click('#bookmarks-list .bmitem[data-id="page0000001"]', { button: 'right' })
    await waitFor(async () => (await menu.labels()).includes('Edit…'))
    await menu.choose('Edit…')
    const bubble = await overlayPage(app)
    expect(await bubble.locator('.sheet-title').innerText()).toBe('Edit bookmark')
    expect(await bubble.locator('input[aria-label="Name"]').inputValue()).toBe('Saved page')
    const item = await chrome.locator('#bookmarks-list .bmitem[data-id="page0000001"]').boundingBox()
    const at = await overlayBounds(app, EDIT)
    expect(Math.abs((at?.x ?? 0) - (item?.x ?? 0))).toBeLessThanOrEqual(4)
    await closing(async () => await bubble.keyboard.press('Escape'))

    // Add Folder… makes a new one at the end of the bar.
    await menu.reset()
    await chrome.mouse.click(900, 90, { button: 'right' })
    await waitFor(async () => (await menu.labels()).includes('Add Folder…'))
    await menu.choose('Add Folder…')
    sheet = await overlayPage(app)
    expect(await sheet.locator('.sheet-title').innerText()).toBe('New folder')
    await sheet.fill('input[aria-label="Name"]', 'Reading')
    await closing(async () => await sheet.keyboard.press('Enter'))
    expect(await fileWhere(app, (roots) => roots.bar.map((node) => node.title).join('|') === 'Jobs|Saved page|Reading')).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
