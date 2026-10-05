// The History page's views in the running shell: site icons (seeded and learned from a visit), the three sorts,
// grouping by session, choosing rows and forgetting them by key and mouse, moving through the list by key, and
// the tabs closed a moment ago. Set ORIVON_UI_SHOTS_DIR to also write screenshots in both colour schemes.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { SqliteHistoryStore } from '../src/main/history/sqlite-history-store.js'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from './support/launch-electron.mjs'
import { clickAddressBarRetrying } from './support/e2e-helpers.js'
import { delay, evaluateRetrying, findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from './support/smoke-helpers.mjs'

const TEST_TIMEOUT_MS = 90_000
const SHOTS_DIR = process.env['ORIVON_UI_SHOTS_DIR']
const DOCS_HOST = 'docs.seeded.example'
const PLAIN_HOST = 'plain.seeded.example'

/** A 16 by 16 PNG of a rounded coloured tile: a real image, so the row draws it the way it draws any site's icon. */
function pngIcon (red: number, green: number, blue: number): string {
  const size = 16
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const inside = (x - 7.5) ** 2 + (y - 7.5) ** 2 <= 49
      raw.set(inside ? [red, green, blue, 255] : [0, 0, 0, 0], y * (size * 4 + 1) + 1 + x * 4)
    }
  }
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (bytes: Buffer): number => { let c = 0xffffffff; for (const byte of bytes) c = (table[(c ^ byte) & 0xff] as number) ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc(body), body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
  return `data:image/png;base64,${png.toString('base64')}`
}

const ICON = pngIcon(0x4f, 0x46, 0xe5)
const ICON_BYTES = Buffer.from(ICON.split(',')[1] as string, 'base64')

let server: Server
let origin = ''

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/icon.png') {
      response.setHeader('content-type', 'image/png')
      response.end(ICON_BYTES)
      return
    }
    response.setHeader('content-type', 'text/html')
    response.end(`<!doctype html><title>Page ${request.url ?? ''}</title><link rel="icon" href="/icon.png"><p>${request.url ?? ''}</p>`)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const local = (daysAgo: number, hour: number, minute = 0): number => {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hour, minute).getTime()
}

/** Forty pages on two hosts over four days: Yesterday holds a session of four pages and one of two, the page numbered 3 has 38 visits, and the docs host has an icon. */
function seed (dir: string, urlFor: (host: string, n: number) => string = (host, n) => `https://${host}/page-${String(n)}`): void {
  const store = new SqliteHistoryStore(join(dir, 'history.db'))
  const times: number[] = [local(1, 12, 0), local(1, 12, 10), local(1, 12, 20), local(1, 12, 30), local(1, 15, 0), local(1, 15, 5), local(2, 10, 0)]
  for (let n = 8; n <= 40; n += 1) times.push(n <= 31 ? local(3, n - 8) : local(4, n - 31))
  times.forEach((at, index) => {
    const n = index + 1
    const url = urlFor(n % 2 === 0 ? DOCS_HOST : PLAIN_HOST, n)
    const title = `Page ${String(n).padStart(2, '0')}`
    if (n === 3) for (let visit = 0; visit < 37; visit += 1) store.record(url, title, local(10, 9, visit))
    store.record(url, title, at)
  })
  store.setFavicon(DOCS_HOST, ICON)
  store.close()
}

async function launched (seedProfile?: (dir: string) => void | Promise<void>): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], ...(seedProfile === undefined ? {} : { seedProfile: async (dir: string) => { await mkdir(dir, { recursive: true }); await seedProfile(dir) } }) })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

async function openHistoryPage (app: ElectronApplication, chrome: Page): Promise<Page> {
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string) => void } }).orivonShell.openInternal('history') })
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://history')))).toBe(true)
  const page = app.windows().find((w) => w.url().startsWith('orivon://history')) as Page
  await page.waitForSelector('.page')
  return page
}

const titles = async (page: Page): Promise<string[]> => await page.locator('.entry .title').allTextContents()
const countText = async (page: Page): Promise<string> => (await page.locator('.count').textContent()) ?? ''

async function shoot (page: Page, name: string): Promise<void> {
  if (SHOTS_DIR === undefined) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  await page.mouse.move(0, 0)
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await delay(250)
    await page.screenshot({ path: join(SHOTS_DIR, `${name}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: null })
}

async function quitAndReopen (app: ElectronApplication): Promise<SqliteHistoryStore> {
  const userData = await app.evaluate(({ app: electron }) => electron.getPath('userData'))
  const exit = new Promise<number | null>((resolve) => { app.process().once('exit', (code) => { resolve(code) }) })
  await app.evaluate(({ app: electron }) => { electron.quit() }).catch(() => {})
  expect(await Promise.race([exit, delay(15_000).then(() => 'still running' as const)])).toBe(0)
  return new SqliteHistoryStore(join(userData, 'history.db'))
}

it('draws a site\'s icon in its rows, sorts by visits and by name, and groups by session', async () => {
  const { app, chrome } = await launched((dir) => { seed(dir) })
  try {
    const page = await openHistoryPage(app, chrome)
    expect(await waitFor(async () => (await titles(page)).length === 40)).toBe(true)

    // Icons: the docs host has one seeded; the plain host shows its letter.
    const docsRow = page.locator('.entry', { has: page.locator('.url', { hasText: `https://${DOCS_HOST}/page-6` }) })
    expect(await docsRow.locator('.site-mark img').getAttribute('src')).toMatch(/^data:image\/png;base64,/)
    const plainRow = page.locator('.entry', { has: page.locator('.url', { hasText: `https://${PLAIN_HOST}/page-5` }) })
    expect(await plainRow.locator('.site-mark img').count()).toBe(0)
    await shoot(page, 'by-day')

    // The row menu opens from the row's button, closes on Escape with the focus back on the button, and can narrow the list to the site.
    await docsRow.hover()
    await docsRow.locator('.more').click()
    const menu = page.locator('.row-menu')
    expect(await menu.locator('[role=menuitem]').allTextContents()).toEqual(['Open in new tab', 'Open in new window', 'Copy link', 'More from this site', 'Remove from history'])
    await shoot(page, 'row-menu')
    await page.keyboard.press('Escape')
    expect(await menu.count()).toBe(0)
    expect(await page.evaluate(() => document.activeElement?.classList.contains('more'))).toBe(true)
    await docsRow.hover()
    await docsRow.locator('.more').click()
    await menu.locator('[role=menuitem]', { hasText: 'More from this site' }).click()
    expect(await page.inputValue('input[type=search]')).toBe(DOCS_HOST)
    expect(await waitFor(async () => (await titles(page)).length === 20)).toBe(true)
    await page.fill('input[type=search]', '')
    expect(await waitFor(async () => (await titles(page)).length === 40)).toBe(true)

    // Most visited: the page with 38 visits leads and says so, with the day it was last seen; grouping is hidden while sorted.
    await page.selectOption('select.sort', 'visits')
    expect(await waitFor(async () => (await titles(page))[0] === 'Page 03')).toBe(true)
    expect(await page.locator('.entry .time').first().locator('span').first().textContent()).toBe('38 visits')
    expect(await page.locator('.entry .time .time-when').first().textContent()).toMatch(/^(Today|Yesterday|[A-Z][a-z]{2} \d{1,2})/)
    expect(await page.locator('.control', { hasText: 'Group' }).isHidden()).toBe(true)
    expect(await page.locator('.day h2').count()).toBe(0)
    await shoot(page, 'most-visited')

    // By name: alphabetical, and back to most recent restores the days.
    await page.selectOption('select.sort', 'title')
    expect(await waitFor(async () => (await titles(page))[0] === 'Page 01')).toBe(true)
    const byName = await titles(page)
    expect(byName).toEqual([...byName].sort())
    await page.selectOption('select.sort', 'recent')
    expect(await waitFor(async () => (await page.locator('.day h2').count()) > 0)).toBe(true)

    // By session: the header reads from the first to the last visit (the day is the heading above it), with the page count; collapsing hides the rows.
    await page.locator('.segmented button', { hasText: 'By session' }).click()
    const time = async (at: number): Promise<string> => await page.evaluate((stamp) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(stamp), at)
    const heads = page.locator('.session-head')
    expect(await heads.first().locator('.session-label').textContent()).toBe(`${await time(local(1, 15, 0))} to ${await time(local(1, 15, 5))}`)
    expect(await heads.first().locator('.session-count').textContent()).toBe('2 pages')
    expect(await heads.nth(1).locator('.session-label').textContent()).toBe(`${await time(local(1, 12, 0))} to ${await time(local(1, 12, 30))}`)
    expect(await heads.nth(1).locator('.session-count').textContent()).toBe('4 pages')
    await shoot(page, 'by-session')
    await heads.nth(1).click()
    expect(await waitFor(async () => (await titles(page)).length === 36)).toBe(true)
    expect(await heads.nth(1).getAttribute('aria-expanded')).toBe('false')
    await heads.nth(1).click()
    expect(await waitFor(async () => (await titles(page)).length === 40)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('chooses rows by key, forgets them with a second press, and the rows are gone from the file', async () => {
  const { app, chrome } = await launched((dir) => { seed(dir) })
  let reopened: SqliteHistoryStore | undefined
  try {
    const page = await openHistoryPage(app, chrome)
    expect(await waitFor(async () => (await titles(page)).length === 40)).toBe(true)
    expect(await countText(page)).toBe('40 pages kept')

    await page.locator('.entry').first().focus()
    await page.keyboard.press('Space')
    await page.keyboard.press('Shift+ArrowDown')
    expect(await page.locator('.selection-count').textContent()).toBe('2 selected')
    expect(await page.locator('.entry.selected').count()).toBe(2)
    await shoot(page, 'selection-bar')

    // Delete asks for the second press; the list holds until it is given.
    await page.keyboard.press('Delete')
    expect(await page.locator('[data-action=delete]').textContent()).toBe('Click again to delete 2')
    expect((await titles(page)).length).toBe(40)
    await page.locator('[data-action=delete]').click()
    expect(await waitFor(async () => (await titles(page)).length === 38)).toBe(true)
    expect(await waitFor(async () => (await countText(page)) === '38 pages kept')).toBe(true)
    expect(await page.locator('.selection-bar').count()).toBe(0)
    // The focus went to the row that followed them.
    expect(await page.evaluate(() => document.activeElement?.classList.contains('entry'))).toBe(true)

    // Escape lets go of a choice without deleting anything.
    await page.keyboard.press('Space')
    expect(await page.locator('.selection-count').textContent()).toBe('1 selected')
    await page.keyboard.press('Escape')
    expect(await page.locator('.selection-bar').count()).toBe(0)
    expect((await titles(page)).length).toBe(38)

    reopened = await quitAndReopen(app)
    expect(reopened.count()).toBe(38)
    const left = reopened.list({ limit: 100 }).map((entry) => entry.title)
    expect(left).not.toContain('Page 06')
    expect(left).not.toContain('Page 05')
  } finally {
    reopened?.close()
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('moves through the list by key and opens a row with Enter, in the background with Ctrl+Enter', async () => {
  const { app, chrome } = await launched((dir) => { seed(dir, (_host, n) => `${origin}/seed-${String(n)}`) })
  try {
    const page = await openHistoryPage(app, chrome)
    expect(await waitFor(async () => (await titles(page)).length === 40)).toBe(true)

    // The list is one Tab stop: only the focused row is in the tab order.
    expect(await page.locator('.entry[tabindex="0"]').count()).toBe(1)
    await page.keyboard.press('/')
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('INPUT')
    await page.keyboard.press('Escape')
    await page.locator('.entry').first().focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    expect(await page.evaluate(() => document.activeElement?.querySelector('.title')?.textContent)).toBe('Page 04')
    await page.keyboard.press('End')
    expect(await page.evaluate(() => document.activeElement?.querySelector('.title')?.textContent)).toBe('Page 32')
    await page.keyboard.press('Home')

    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    const tabCount = async (): Promise<number> => await evaluateRetrying(chrome, () => document.querySelectorAll('.tab').length)
    const before = await tabCount()
    await page.keyboard.press('Control+Enter')
    expect(await waitFor(async () => await tabCount() === before + 1)).toBe(true)
    // The page stays where it is: a background tab opens, and this one keeps the list.
    expect(page.url()).toBe('orivon://history/')

    // The tab leaves the shell's own session, so its page is replaced under the key press.
    await page.keyboard.press('Enter').catch(() => {})
    expect(await waitFor(() => app.windows().some((w) => w.url() === `${origin}/seed-4`))).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('learns a site\'s icon from a visit, lists the tabs just closed, and brings one back with Enter', async () => {
  const { app, chrome } = await launched()
  try {
    const page = await openHistoryPage(app, chrome)
    expect(await page.locator('.empty').textContent()).toContain('Pages you visit appear here.')
    await shoot(page, 'empty')

    await chrome.evaluate(() => { (window as unknown as { orivonShell: { newTab: () => void } }).orivonShell.newTab() })
    await clickAddressBarRetrying(chrome, `${origin}/lives-here`)
    expect((await waitForTab(chrome, { address: `${origin}/lives-here` })).ok).toBe(true)
    await chrome.evaluate((url) => { (window as unknown as { orivonShell: { newTab: (u: string) => void } }).orivonShell.newTab(url) }, `${origin}/closeme`)
    expect(await waitFor(async () => (await evaluateRetrying(chrome, () => Array.from(document.querySelectorAll('.tab .title')).map((el) => el.textContent))).includes('Page /closeme'))).toBe(true)

    // The page catches up on what happened while it was out of sight when it is shown again.
    await openHistoryPage(app, chrome)
    // The icon of the visited site arrives with the tab and is kept with the page.
    expect(await waitFor(async () => (await page.locator('.entry .site-mark img').count()) > 0, 15_000)).toBe(true)
    expect(await page.locator('.entry .site-mark img').first().getAttribute('src')).toMatch(/^data:image\/png;base64,/)

    const tabId = await evaluateRetrying(chrome, () => Array.from(document.querySelectorAll<HTMLElement>('.tab')).find((el) => el.querySelector('.title')?.textContent === 'Page /closeme')?.dataset['id'] ?? '')
    await chrome.evaluate((id) => { (window as unknown as { orivonShell: { closeTab: (i: string) => void } }).orivonShell.closeTab(id) }, tabId)
    expect(await waitFor(async () => (await page.locator('.closed .item-title').count()) === 1)).toBe(true)
    expect(await page.locator('.closed .item-title').textContent()).toBe('Page /closeme')
    expect(await page.locator('.closed .item-sub').textContent()).toBe(`${origin}/closeme`)
    await shoot(page, 'recently-closed')

    await page.locator('.closed .listbox-item').first().focus()
    await page.keyboard.press('Enter')
    expect(await waitFor(async () => (await page.locator('.closed .item-title').count()) === 0)).toBe(true)
    expect(await waitFor(async () => (await evaluateRetrying(chrome, () => Array.from(document.querySelectorAll('.tab .title')).map((el) => el.textContent))).includes('Page /closeme'))).toBe(true)

    // A search with no match says so, and the closed card is not part of search results.
    await openHistoryPage(app, chrome)
    await page.fill('input[type=search]', 'zzz-nothing')
    expect(await waitFor(async () => (await page.locator('.empty').count()) === 1)).toBe(true)
    expect(await page.locator('.empty').textContent()).toContain('No page matches "zzz-nothing".')
    expect(await page.locator('.closed').count()).toBe(0)
    await shoot(page, 'no-match')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
