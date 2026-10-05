// The Bookmarks page in the running shell: Mod+Shift+O opens it, the tree and list show the stored order, a folder
// is entered and left by key, a rename shows on the bar and a page starred elsewhere shows in the list, a bad address
// keeps the form open, a new folder takes a page by the Move sheet, Alt+Up and drag reorder, delete can be undone,
// search marks what it found, and the file is saved as the HTML every browser reads.
// Set ORIVON_UI_SHOTS_DIR to also write screenshots in both colour schemes.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput, profileDirOf } from './support/launch-electron.mjs'
import { pressKey } from './support/e2e-helpers.js'
import { delay, evaluateRetrying, findChrome, HERMETIC_RESOLVER, tabIds, waitFor } from './support/smoke-helpers.mjs'

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
let scratch = ''

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end(`<!doctype html><title>Page ${request.url ?? ''}</title><p>${request.url ?? ''}</p>`)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  scratch = await mkdtemp(join(tmpdir(), 'orivon-bookmarks-manager-'))
  if (SHOTS_DIR !== undefined) mkdirSync(SHOTS_DIR, { recursive: true })
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  await rm(scratch, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const pageUrl = (name: string): string => `${origin}/${name}`

interface SeedNode { id: string, kind: 'url' | 'folder', title: string, url?: string, favicon?: string, added: number, children?: SeedNode[] }
const leaf = (id: string, title: string, colour: number): SeedNode => ({ id, kind: 'url', title, url: pageUrl(id), favicon: icon(COLOURS[colour % COLOURS.length] as [number, number, number]), added: 1 })

/** The bar: three pages and a folder "Work" holding two pages and a nested folder; Other bookmarks: one page. */
function seed (): string {
  const deep: SeedNode = { id: 'deep0000000', kind: 'folder', title: 'Deep folder', added: 1, children: [leaf('deepa', 'Deep page', 4)] }
  const work: SeedNode = { id: 'work0000000', kind: 'folder', title: 'Work', added: 1, children: [leaf('w1', 'Design notes', 1), leaf('w2', 'Sprint board', 2), deep] }
  const bar: SeedNode[] = [leaf('alpha', 'Alpha', 0), leaf('bravo', 'Bravo', 1), work, leaf('charlie', 'Charlie', 3)]
  return JSON.stringify({ version: 2, roots: { bar, other: [leaf('other1', 'Other page', 5)], reading: [] } })
}

async function launched (seedFile?: string): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({ appPath: '.', ...SILENT, ...(seedFile === undefined ? {} : { seedProfile: async (dir: string) => { await writeFile(join(dir, 'bookmarks.json'), seedFile) } }) })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

const managerOf = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().startsWith('orivon://bookmarks'))

async function managerPage (app: ElectronApplication): Promise<Page> {
  expect(await waitFor(() => managerOf(app) !== undefined)).toBe(true)
  const page = managerOf(app) as Page
  await page.waitForSelector('.bm-list, .empty-state')
  return page
}

/** Opens the manager with its own shortcut, as a person would. */
async function openWithShortcut (app: ElectronApplication): Promise<Page> {
  expect(await waitFor(() => app.windows().some((w) => w.url().includes('/newtab/')))).toBe(true)
  await pressKey(app, '/newtab/', 'O', ['control', 'shift'])
  return await managerPage(app)
}

async function fileOf (app: ElectronApplication): Promise<{ roots: Record<string, SeedNode[]> }> {
  return JSON.parse(await readFile(join(profileDirOf(app) as string, 'bookmarks.json'), 'utf8')) as never
}

const titlesIn = async (page: Page): Promise<string[]> => await page.locator('.bm-list .bm-row .bm-title').allInnerTexts()
const barTitles = async (chrome: Page): Promise<string[]> => await evaluateRetrying(chrome, () =>
  Array.from(document.querySelectorAll<HTMLElement>('#bookmarks-list .bmitem')).filter((el) => !el.hidden).map((el) => el.getAttribute('aria-label') ?? ''))
const rowOf = (page: Page, title: string) => page.locator('.bm-row', { has: page.locator('.bm-title', { hasText: new RegExp(`^${title}$`) }) })
const crumbs = async (page: Page): Promise<string> => (await page.locator('.crumbs li').allInnerTexts()).map((text) => text.trim()).filter((text) => text !== '').join(' ')

/** `park`: move the pointer off every control first, so no hover look is in the picture (not while a drag is on). */
async function shoot (page: Page, name: string, park = true): Promise<void> {
  if (SHOTS_DIR === undefined) return
  if (park) await page.mouse.move(2, 2)
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await delay(350)
    await page.screenshot({ path: join(SHOTS_DIR, `${name}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: null })
}

it('opens with Mod+Shift+O, shows both roots and the stored order, enters a folder by key and follows a deep link', async () => {
  const { app, chrome } = await launched(seed())
  try {
    const page = await openWithShortcut(app)
    expect(await page.locator('.tree-label').allInnerTexts()).toEqual(['Bookmarks bar', 'Work', 'Other bookmarks'])
    expect(await titlesIn(page)).toEqual(['Alpha', 'Bravo', 'Work', 'Charlie'])
    expect(await page.locator('.bm-row .bm-sub').allInnerTexts()).toEqual([`${origin.replace('http://', '')}/alpha`, `${origin.replace('http://', '')}/bravo`, '3 items', `${origin.replace('http://', '')}/charlie`])

    await rowOf(page, 'Bravo').click()
    await rowOf(page, 'Bravo').press('Shift+ArrowDown')
    await shoot(page, 'populated-selection')

    await rowOf(page, 'Work').focus()
    await page.keyboard.press('Enter')
    expect(await waitFor(async () => (await crumbs(page)) === 'Bookmarks bar / Work')).toBe(true)
    expect(await titlesIn(page)).toEqual(['Design notes', 'Sprint board', 'Deep folder'])
    expect(page.url()).toBe('orivon://bookmarks/folder/work0000000')
    await page.keyboard.press('Backspace')
    expect(await waitFor(async () => (await crumbs(page)) === 'Bookmarks bar')).toBe(true)
    expect(await waitFor(async () => (await page.evaluate(() => document.activeElement?.textContent ?? '')).includes('Work'))).toBe(true)

    // A deep link opens in the folder it names; one that names nothing shows the bar.
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (p: string, path?: string) => void } }).orivonShell.openInternal('bookmarks', '/folder/deep0000000') })
    expect(await waitFor(async () => (await Promise.all(app.windows().filter((w) => w.url().startsWith('orivon://bookmarks')).map(async (w) => await w.locator('.crumb-here').innerText().catch(() => '')))).includes('Deep folder'))).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('renames by F2 and the bar follows, shows a page starred elsewhere, and keeps the form open on a bad address', async () => {
  const { app, chrome } = await launched(seed())
  try {
    const page = await openWithShortcut(app)
    const managerTab = (await tabIds(chrome)).at(-1) as string

    await rowOf(page, 'Alpha').click()
    await page.keyboard.press('F2')
    const name = page.locator('.bm-edit input[aria-label="Name"]')
    await name.fill('Alpha renamed')
    await page.keyboard.press('Enter')
    expect(await waitFor(async () => (await titlesIn(page))[0] === 'Alpha renamed')).toBe(true)
    expect(await waitFor(async () => (await barTitles(chrome))[0] === 'Alpha renamed')).toBe(true)
    expect(await waitFor(async () => (await fileOf(app)).roots['bar']?.[0]?.title === 'Alpha renamed')).toBe(true)

    // A page starred from another tab appears here once this tab is back in front.
    await chrome.evaluate((url) => { (window as unknown as { orivonShell: { newTab: (u: string) => void } }).orivonShell.newTab(url) }, pageUrl('starred'))
    expect(await waitFor(async () => (await tabIds(chrome)).length === 3)).toBe(true)
    const starredTab = (await tabIds(chrome)).at(-1) as string
    await chrome.evaluate(([url, id]) => { (window as unknown as { orivonShell: { addBookmark: (u: string, t: string, id: string) => void } }).orivonShell.addBookmark(url as string, 'Starred page', id as string) }, [pageUrl('starred'), starredTab] as const)
    expect(await waitFor(async () => (await barTitles(chrome)).includes('Starred page'))).toBe(true)
    await chrome.click(`.tab[data-id="${managerTab}"]`)
    expect(await waitFor(async () => (await titlesIn(page)).includes('Starred page'))).toBe(true)

    // Both directions: the list is the store, so a delete there leaves the bar too.
    await rowOf(page, 'Bravo').click()
    await page.keyboard.press('F2')
    await page.locator('.bm-edit input[aria-label="Address"]').fill('not a web address')
    await page.keyboard.press('Enter')
    expect(await page.locator('.bm-edit .problem').innerText()).toBe('Enter a web address that starts with http:// or https://')
    expect(await page.locator('.bm-edit').count()).toBe(1)
    await shoot(page, 'inline-edit-error')
    await page.keyboard.press('Escape')
    expect(await page.locator('.bm-edit').count()).toBe(0)
    expect((await fileOf(app)).roots['bar']?.find((node) => node.title === 'Bravo')?.url).toBe(pageUrl('bravo'))
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('makes a folder, files a page in it by the Move sheet, reorders by Alt+Up and by drag, and takes a delete back', async () => {
  const { app, chrome } = await launched(seed())
  try {
    const page = await openWithShortcut(app)

    await page.getByRole('button', { name: 'New folder' }).click()
    await page.locator('.bm-edit input').waitFor()
    await page.keyboard.type('Archive')
    await page.keyboard.press('Enter')
    expect(await waitFor(async () => (await titlesIn(page))[0] === 'Archive')).toBe(true)

    await rowOf(page, 'Alpha').click()
    await rowOf(page, 'Alpha').locator('.more').click()
    await page.getByRole('menuitem', { name: 'Move to…' }).click()
    await page.locator('.move-sheet').waitFor()
    await page.locator('.move-sheet .tree-item', { hasText: 'Archive' }).click()
    await shoot(page, 'move-sheet')
    await page.getByRole('button', { name: 'Move', exact: true }).click()
    expect(await waitFor(async () => !(await titlesIn(page)).includes('Alpha'))).toBe(true)
    expect(await waitFor(async () => (await fileOf(app)).roots['bar']?.find((node) => node.title === 'Archive')?.children?.[0]?.title === 'Alpha')).toBe(true)
    expect(await waitFor(async () => !(await barTitles(chrome)).includes('Alpha'))).toBe(true)

    // Alt+Up moves a row one place and the bar follows.
    await rowOf(page, 'Charlie').click()
    await page.keyboard.press('Alt+ArrowUp')
    expect(await waitFor(async () => (await titlesIn(page)).join() === 'Archive,Bravo,Charlie,Work')).toBe(true)
    expect(await waitFor(async () => (await barTitles(chrome)).join() === 'Archive,Bravo,Charlie,Work')).toBe(true)

    // Delete, the toast, Undo.
    await rowOf(page, 'Bravo').click()
    await page.keyboard.press('Delete')
    expect(await page.locator('.toast').innerText()).toContain('Deleted "Bravo"')
    expect(await waitFor(async () => !(await titlesIn(page)).includes('Bravo'))).toBe(true)
    await shoot(page, 'toast')
    await page.locator('.toast .link-btn').click()
    expect(await waitFor(async () => (await titlesIn(page)).join() === 'Archive,Bravo,Charlie,Work')).toBe(true)

    // Drag: Charlie onto the Work folder.
    const charlie = (await rowOf(page, 'Charlie').boundingBox()) as { x: number, y: number, width: number, height: number }
    const work = (await rowOf(page, 'Work').boundingBox()) as { x: number, y: number, width: number, height: number }
    await page.mouse.move(charlie.x + 80, charlie.y + charlie.height / 2)
    await page.mouse.down()
    await page.mouse.move(charlie.x + 90, charlie.y + charlie.height / 2 - 12, { steps: 4 })
    await page.mouse.move(work.x + 90, work.y + work.height / 2, { steps: 8 })
    expect(await page.locator('.bm-row.drop-into').count()).toBe(1)
    await shoot(page, 'drag-into-folder', false)
    await page.mouse.up()
    expect(await waitFor(async () => !(await titlesIn(page)).includes('Charlie'))).toBe(true)
    expect(await waitFor(async () => (await fileOf(app)).roots['bar']?.find((node) => node.title === 'Work')?.children?.some((node) => node.title === 'Charlie') === true)).toBe(true)

    // Drag between rows: a line shows the gap, and Escape leaves everything as it was.
    const bravo = (await rowOf(page, 'Bravo').boundingBox()) as { x: number, y: number, width: number, height: number }
    await page.mouse.move(bravo.x + 80, bravo.y + bravo.height / 2)
    await page.mouse.down()
    await page.mouse.move(bravo.x + 90, bravo.y + bravo.height / 2 + 10, { steps: 4 })
    await page.mouse.move(bravo.x + 90, bravo.y - 2, { steps: 6 })
    expect(await page.locator('.drop-line:not([hidden])').count()).toBe(1)
    await shoot(page, 'drag-line', false)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    expect(await page.locator('.drop-line').count()).toBe(0)
    expect(await titlesIn(page)).toEqual(['Archive', 'Bravo', 'Work'])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('searches both roots with the match marked, says when nothing matches, and saves the bookmarks as an HTML file', async () => {
  const { app } = await launched(seed())
  try {
    const page = await openWithShortcut(app)
    await page.locator('input[type=search]').fill('deep')
    expect(await waitFor(async () => (await page.locator('.crumb-here').innerText()) === 'Search results')).toBe(true)
    expect(await titlesIn(page)).toEqual(['Deep page'])
    expect(await page.locator('.bm-path').innerText()).toBe('in Bookmarks bar / Work / Deep folder')
    expect(await page.locator('.bm-title mark').innerText()).toBe('Deep')
    expect(await page.locator('.tree-item[aria-selected="true"]').count()).toBe(0)
    await shoot(page, 'search')
    await page.locator('input[type=search]').fill('other page')
    expect(await waitFor(async () => (await titlesIn(page)).join() === 'Other page')).toBe(true)
    await page.locator('input[type=search]').fill('zzzz')
    expect(await waitFor(async () => (await page.locator('.empty-state').count()) === 1)).toBe(true)
    expect(await page.locator('.empty-state').innerText()).toContain('No bookmarks match "zzzz".')
    await shoot(page, 'no-match')
    await page.locator('input[type=search]').press('Escape')
    expect(await waitFor(async () => (await titlesIn(page)).length === 4)).toBe(true)

    const target = join(scratch, 'export.html')
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as unknown as typeof dialog.showSaveDialog }, target)
    await page.getByRole('button', { name: 'More', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Export bookmarks…' }).click()
    expect(await waitFor(() => existsSync(target))).toBe(true)
    const html = await readFile(target, 'utf8')
    expect(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>')).toBe(true)
    expect(html).toContain('PERSONAL_TOOLBAR_FOLDER="true"')
    expect(html).toContain('>Deep folder</H3>')
    expect(html).toContain(`HREF="${pageUrl('deepa')}"`)
    expect(html).toContain('>Other page</A>')
    expect(await waitFor(async () => (await page.locator('.toast').innerText().catch(() => '')).includes('Exported 7 bookmarks.'))).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('says a new profile has no bookmarks and points at the star and at import', async () => {
  const { app } = await launched()
  try {
    const page = await openWithShortcut(app)
    expect(await page.locator('.empty-state').innerText()).toContain('This folder is empty.')
    expect(await page.locator('.empty-state').innerText()).toContain('Bookmark a page with the bookmark button next to the address bar (Ctrl+D), or import bookmarks from another browser.')
    expect(await page.locator('.tree-label').allInnerTexts()).toEqual(['Bookmarks bar', 'Other bookmarks'])
    await shoot(page, 'empty')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('tells a private window that what it bookmarks is forgotten, and keeps its own store', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER, '--alsa-output-device=null', '--orivon-private'], env: SILENT.env })
  try {
    expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
    const chrome = findChrome(app)
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (p: string) => void } }).orivonShell.openInternal('bookmarks') })
    const page = await managerPage(app)
    expect(await page.locator('.banner.info').innerText()).toBe('Bookmarks added in a private window are forgotten when it closes.')
    expect(await page.locator('.empty-state').count()).toBe(1)
    await shoot(page, 'private')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
