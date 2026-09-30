// Tab search in the running shell: Mod+Shift+A lists the open tabs of every window and what was closed,
// typing filters and highlights, Enter goes there (across windows too), Shift+Delete and the middle button
// close from the list without closing it, Escape clears and then closes, and the main menu and the strip
// button open it. Set ORIVON_UI_SHOTS_DIR to also write screenshots in both colour schemes.
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from './launch-electron.mjs'
import { pressKey } from './e2e-helpers.js'
import { delay, evaluateRetrying, findChrome, HERMETIC_RESOLVER, popoverShown, waitFor } from './smoke-helpers.mjs'

const TEST_TIMEOUT_MS = 120_000
const SHOTS_DIR = process.env.ORIVON_UI_SHOTS_DIR
const SILENT = { args: [HERMETIC_RESOLVER, '--alsa-output-device=null'], env: { PULSE_SERVER: 'unix:/nonexistent' } }

const TITLES: Record<string, string> = { alpha: 'Alpha report', beta: 'Beta notes', gamma: 'Gamma', delta: 'Delta window', radio: 'Radio', long: 'A page with a very long title that cannot possibly fit on one line of the list without being cut short' }
const COLOURS: Record<string, [number, number, number]> = { alpha: [220, 38, 38], beta: [37, 99, 235], gamma: [22, 163, 74], delta: [234, 88, 12], radio: [147, 51, 234], long: [13, 148, 136] }

/** A 16px PNG of one colour: a favicon the shell will accept and re-encode. */
function png (colour: [number, number, number]): Buffer {
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
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))), chunk('IEND', Buffer.alloc(0))])
}

const TONE = `<script>window.start = async () => { const c = new AudioContext(); const o = c.createOscillator(); o.connect(c.destination); await c.resume(); o.start(); return c.state }</script>`

let server: Server
let origin = ''

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = (request.url ?? '/').slice(1)
    const name = path.replace(/\.png$/, '')
    if (path.endsWith('.png') && COLOURS[name] !== undefined) {
      response.setHeader('content-type', 'image/png')
      response.end(png(COLOURS[name]))
      return
    }
    response.setHeader('content-type', 'text/html')
    response.end(`<!doctype html><title>${TITLES[path] ?? path}</title><link rel="icon" href="/${path}.png"><p>${path}</p>${path === 'radio' ? TONE : ''}`)
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
interface StripTab { id: string, title: string, active: boolean, pinned: boolean }

const chromePages = (app: App): Page[] => app.windows().filter((w) => w.url().endsWith('/renderer/index.html'))
const overlayOf = (app: App): Page | undefined => app.windows().find((w) => w.url().includes('overlay=tab-search'))
const shown = async (app: App): Promise<boolean> => await popoverShown(app, 'overlay=tab-search')
const pageUrl = (name: string): string => `${origin}/${name}`

async function launched (): Promise<{ app: App, chrome: Page, problems: string[] }> {
  const app = await launchElectron({ appPath: '.', ...SILENT })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app), problems: [] }
}

const strip = async (chrome: Page): Promise<StripTab[]> => await evaluateRetrying(chrome, () =>
  Array.from(document.querySelectorAll<HTMLElement>('.tab')).map((el) => ({
    id: el.dataset['id'] ?? '', title: el.querySelector('.title')?.textContent ?? '', active: el.classList.contains('active'), pinned: el.classList.contains('pinned')
  })))
const stripTitles = async (chrome: Page): Promise<string[]> => (await strip(chrome)).map((tab) => tab.title)
const activeTitle = async (chrome: Page): Promise<string | undefined> => (await strip(chrome)).find((tab) => tab.active)?.title

async function expectStrip (chrome: Page, expected: string[]): Promise<void> {
  let seen: string[] = []
  const ok = await waitFor(async () => { seen = await stripTitles(chrome); return JSON.stringify(seen) === JSON.stringify(expected) })
  expect({ ok, seen }).toEqual({ ok: true, seen: expected })
}

async function openPage (app: App, chrome: Page, name: string, expected: string[]): Promise<void> {
  await chrome.evaluate((url) => { (window as unknown as { orivonShell: { newTab: (u: string) => void } }).orivonShell.newTab(url) }, pageUrl(name))
  await expectStrip(chrome, expected)
  await settled(app, pageUrl(name))
}

/** The page must have loaded before a key is sent to it. */
async function settled (app: App, url: string): Promise<void> {
  expect(await waitFor(async () => await app.evaluate(({ webContents }, part) => webContents.getAllWebContents().some((wc) => wc.getURL() === part && !wc.isLoading()), url))).toBe(true)
}

const command = async (chrome: Page, id: string): Promise<void> => {
  await chrome.evaluate((commandId) => { (window as unknown as { orivonShell: { runCommand: (i: string) => void } }).orivonShell.runCommand(commandId) }, id)
}

/** Opens tab search with its key, sent to the page at `url`. */
async function openList (app: App, url: string): Promise<Page> {
  await settled(app, url)
  await pressKey(app, url, 'A', ['control', 'shift'])
  return await listPage(app)
}

async function listPage (app: App): Promise<Page> {
  expect(await waitFor(async () => await shown(app))).toBe(true)
  expect(await waitFor(() => overlayOf(app) !== undefined)).toBe(true)
  const page = overlayOf(app) as Page
  await page.waitForSelector('.ts-input')
  await waitFor(async () => await page.locator('.listbox-item').count() > 0)
  return page
}

const rowTitles = async (page: Page): Promise<string[]> => await page.locator('.listbox-item .item-title').allInnerTexts()
const countOf = async (page: Page): Promise<string> => (await page.locator('.ts-count').textContent()) ?? ''
const groupsOf = async (page: Page): Promise<string[]> => await page.locator('.ts-group').allTextContents()
const selectedTitle = async (page: Page): Promise<string> => (await page.locator('.listbox-item[aria-selected="true"] .item-title').innerText())

async function expectRows (page: Page, expected: string[]): Promise<void> {
  let seen: string[] = []
  const ok = await waitFor(async () => { seen = await rowTitles(page); return JSON.stringify(seen) === JSON.stringify(expected) })
  expect({ ok, seen }).toEqual({ ok: true, seen: expected })
}

async function expectCount (page: Page, text: string): Promise<void> {
  let seen = ''
  const ok = await waitFor(async () => { seen = await countOf(page); return seen === text })
  expect({ ok, seen }).toEqual({ ok: true, seen: text })
}

/** A key that closes the overlay destroys the page it was sent to, which Playwright reports as a failed press. */
async function closingPress (page: Page, key: string): Promise<void> {
  await page.keyboard.press(key).catch(() => {})
}

const gone = async (app: App): Promise<boolean> => await waitFor(async () => !(await shown(app)))
const pageFocused = async (app: App, url: string): Promise<boolean> =>
  await app.evaluate(({ webContents }, part) => webContents.getAllWebContents().find((wc) => wc.getURL() === part)?.isFocused() === true, url)

async function shoot (app: App, chrome: Page, list: Page | undefined, name: string): Promise<void> {
  if (SHOTS_DIR === undefined) return
  for (const scheme of ['light', 'dark'] as const) {
    await chrome.emulateMedia({ colorScheme: scheme })
    await list?.emulateMedia({ colorScheme: scheme })
    await delay(300)
    execFileSync('import', ['-window', 'root', join(SHOTS_DIR, `${name}-window-${scheme}.png`)])
    if (list !== undefined) await list.screenshot({ path: join(SHOTS_DIR, `${name}-${scheme}.png`) })
  }
  await chrome.emulateMedia({ colorScheme: null })
  await list?.emulateMedia({ colorScheme: null })
  expect(app).toBeDefined()
}

it('opens on the key with every tab, filters with a highlight, goes to the tab on Enter and says when nothing matches', async () => {
  const { app, chrome } = await launched()
  try {
    await openPage(app, chrome, 'alpha', ['New Tab', 'Alpha report'])
    await openPage(app, chrome, 'beta', ['New Tab', 'Alpha report', 'Beta notes'])
    await openPage(app, chrome, 'gamma', ['New Tab', 'Alpha report', 'Beta notes', 'Gamma'])
    expect(await shown(app)).toBe(false)

    const list = await openList(app, pageUrl('gamma'))
    await expectRows(list, ['New tab', 'Alpha report', 'Beta notes', 'Gamma'])
    await expectCount(list, '4 tabs')
    expect(await groupsOf(list)).toEqual(['Open tabs'])
    expect(await selectedTitle(list)).toBe('New tab')
    expect(await list.evaluate(() => document.activeElement?.classList.contains('ts-input'))).toBe(true)
    expect(await list.locator('.listbox-item').last().locator('.badge').innerText()).toBe('This tab')
    expect(await list.locator('.ts-input').getAttribute('aria-activedescendant')).toBe(await list.locator('.listbox-item[aria-selected="true"]').getAttribute('id'))

    await list.keyboard.type('bet')
    await expectRows(list, ['Beta notes'])
    expect(await list.locator('.item-title mark').allInnerTexts()).toEqual(['Bet'])
    await closingPress(list, 'Enter')
    expect(await gone(app)).toBe(true)
    expect(await waitFor(async () => await activeTitle(chrome) === 'Beta notes')).toBe(true)
    expect(await waitFor(async () => await pageFocused(app, pageUrl('beta')))).toBe(true)

    // Nothing matches: the words, quoting what was typed.
    const again = await openList(app, pageUrl('beta'))
    // Tab reaches the close button of the selected row and only that one; Shift+Tab goes back to the field.
    await again.keyboard.press('Tab')
    expect(await again.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Close Gamma')
    await again.keyboard.press('Shift+Tab')
    expect(await again.evaluate(() => document.activeElement?.classList.contains('ts-input'))).toBe(true)
    await again.keyboard.type('zzz')
    expect(await again.locator('.empty-state').innerText()).toBe('No tabs match "zzz".')
    expect(await again.locator('.listbox-item').count()).toBe(0)
    await shoot(app, chrome, again, 'none')

    // Escape clears what was typed, and closes only on the second press, leaving the page the keys.
    await again.keyboard.press('Escape')
    expect(await again.locator('.ts-input').inputValue()).toBe('')
    expect(await again.locator('.listbox-item').count()).toBe(4)
    expect(await shown(app)).toBe(true)
    await again.keyboard.press('Escape').catch(() => {})
    expect(await gone(app)).toBe(true)
    expect(await waitFor(async () => await pageFocused(app, pageUrl('beta')))).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('closes from the list without closing it, offers what it closed, and reopens it; the most recently used tab comes first', async () => {
  const { app, chrome } = await launched()
  try {
    await openPage(app, chrome, 'alpha', ['New Tab', 'Alpha report'])
    await openPage(app, chrome, 'beta', ['New Tab', 'Alpha report', 'Beta notes'])
    await openPage(app, chrome, 'gamma', ['New Tab', 'Alpha report', 'Beta notes', 'Gamma'])

    // Put Alpha in front last but one, so the list orders by use and not by the strip.
    const first = await openList(app, pageUrl('gamma'))
    await first.keyboard.press('ArrowDown')
    expect(await selectedTitle(first)).toBe('Alpha report')
    await closingPress(first, 'Enter')
    expect(await gone(app)).toBe(true)
    expect(await waitFor(async () => await activeTitle(chrome) === 'Alpha report')).toBe(true)

    // Most recently used first (Gamma was in front before Alpha), the tab the person is on last.
    const list = await openList(app, pageUrl('alpha'))
    await expectRows(list, ['Gamma', 'New tab', 'Beta notes', 'Alpha report'])
    await list.keyboard.press('ArrowDown')
    await list.keyboard.press('ArrowDown')
    expect(await selectedTitle(list)).toBe('Beta notes')
    await list.keyboard.press('Shift+Delete')
    // The row is gone at once, the next one is selected, and the list stays open.
    await expectRows(list, ['Gamma', 'New tab', 'Alpha report', 'Beta notes'])
    expect(await groupsOf(list)).toEqual(['Open tabs', 'Recently closed'])
    await expectCount(list, '3 tabs')
    expect(await selectedTitle(list)).toBe('Alpha report')
    expect(await shown(app)).toBe(true)
    await expectStrip(chrome, ['New Tab', 'Alpha report', 'Gamma'])
    await shoot(app, chrome, list, 'closed')

    // Reopen it from the list: it comes back where it was.
    await list.keyboard.press('ArrowDown')
    expect(await selectedTitle(list)).toBe('Beta notes')
    await closingPress(list, 'Enter')
    expect(await gone(app)).toBe(true)
    await expectStrip(chrome, ['New Tab', 'Alpha report', 'Beta notes', 'Gamma'])
    expect(await waitFor(async () => await activeTitle(chrome) === 'Beta notes')).toBe(true)

    // Closing the tab the person is on keeps the list open too: the tab that takes its place is not a switch away.
    const third = await openList(app, pageUrl('beta'))
    await third.keyboard.press('End')
    expect(await selectedTitle(third)).toBe('Beta notes')
    await third.keyboard.press('Shift+Delete')
    await expectCount(third, '3 tabs')
    expect(await shown(app)).toBe(true)
    await expectStrip(chrome, ['New Tab', 'Alpha report', 'Gamma'])
    // Typing still works: the list kept the keys while a page took the front.
    await third.keyboard.type('gam')
    await expectRows(third, ['Gamma'])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('lists the tabs of every window, closes one of another window with the middle button, and goes to another window\'s tab', async () => {
  const { app, chrome } = await launched()
  try {
    await openPage(app, chrome, 'alpha', ['New Tab', 'Alpha report'])
    await command(chrome, 'window.new')
    expect(await waitFor(() => chromePages(app).length === 2)).toBe(true)
    const second = chromePages(app).find((page) => page !== chrome) as Page
    await openPage(app, second, 'delta', ['New Tab', 'Delta window'])
    await openPage(app, second, 'beta', ['New Tab', 'Delta window', 'Beta notes'])
    await openPage(app, second, 'gamma', ['New Tab', 'Delta window', 'Beta notes', 'Gamma'])

    const list = await openList(app, pageUrl('alpha'))
    await expectCount(list, '6 tabs in 2 windows')
    expect(await list.locator('.listbox-item', { hasText: 'Delta window' }).locator('.badge').innerText()).toBe('Window 2')
    expect(await list.locator('.listbox-item', { hasText: 'Alpha report' }).locator('.badge').innerText()).toBe('This tab')

    // The middle button closes the tab of the other window; the list follows.
    await list.locator('.listbox-item', { hasText: 'Delta window' }).click({ button: 'middle' })
    await expectCount(list, '5 tabs in 2 windows')
    await expectStrip(second, ['New Tab', 'Beta notes', 'Gamma'])
    // The close button of a row does the same, and leaves the typing where it was.
    const beta = list.locator('.listbox-item', { hasText: 'Beta notes' })
    await beta.hover()
    await beta.getByRole('button', { name: 'Close Beta notes' }).click()
    await expectCount(list, '4 tabs in 2 windows')
    await expectStrip(second, ['New Tab', 'Gamma'])
    expect(await list.evaluate(() => document.activeElement?.classList.contains('ts-input'))).toBe(true)
    // The closed entry arrives with main's next update.
    expect(await waitFor(async () => (await groupsOf(list)).join() === 'Open tabs,Recently closed')).toBe(true)
    expect(await shown(app)).toBe(true)

    // Enter goes to the other window's tab: its window takes the front and its page the keys.
    await list.keyboard.type('gam')
    await expectRows(list, ['Gamma'])
    await closingPress(list, 'Enter')
    expect(await gone(app)).toBe(true)
    expect(await waitFor(async () => await activeTitle(second) === 'Gamma')).toBe(true)
    expect(await waitFor(async () => await pageFocused(app, pageUrl('gamma')))).toBe(true)
    const focused = await app.evaluate(({ BaseWindow, webContents }) => {
      const owner = BaseWindow.getFocusedWindow()
      const gamma = webContents.getAllWebContents().find((wc) => wc.getURL().endsWith('/gamma'))
      return owner === null ? null : owner.contentView.children.some((view) => (view as unknown as { webContents?: unknown }).webContents === gamma)
    })
    expect(focused).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('opens from the main menu and from the strip button, and brings back a closed window', async () => {
  const { app, chrome } = await launched()
  try {
    await openPage(app, chrome, 'alpha', ['New Tab', 'Alpha report'])

    await chrome.click('#menu')
    expect(await waitFor(async () => await popoverShown(app, 'overlay=menu'))).toBe(true)
    expect(await waitFor(() => app.windows().some((w) => w.url().includes('overlay=menu')))).toBe(true)
    const menu = app.windows().find((w) => w.url().includes('overlay=menu')) as Page
    await menu.waitForSelector('.menu-row')
    await menu.locator('.menu-row', { hasText: 'More tools' }).click()
    await menu.getByRole('menuitem', { name: /^Search tabs/ }).click()
    const fromMenu = await listPage(app)
    await expectCount(fromMenu, '2 tabs')
    await fromMenu.keyboard.press('Escape').catch(() => {})
    expect(await gone(app)).toBe(true)

    // The strip button carries its name and the key, and toggles the list.
    const button = chrome.locator('#tab-search')
    expect(await button.getAttribute('aria-label')).toBe('Search tabs')
    expect(await button.getAttribute('title')).toBe('Search tabs (Ctrl+Shift+A)')
    await button.click()
    const fromButton = await listPage(app)
    await expectCount(fromButton, '2 tabs')
    await shoot(app, chrome, fromButton, 'button')
    await fromButton.keyboard.press('Escape').catch(() => {})
    expect(await gone(app)).toBe(true)

    // A window closed a moment ago is offered, and comes back with its tabs.
    await command(chrome, 'window.new')
    expect(await waitFor(() => chromePages(app).length === 2)).toBe(true)
    const second = chromePages(app).find((page) => page !== chrome) as Page
    await openPage(app, second, 'delta', ['New Tab', 'Delta window'])
    await command(second, 'window.close')
    expect(await waitFor(() => chromePages(app).length === 1)).toBe(true)
    const closed = await openList(app, pageUrl('alpha'))
    await expectCount(closed, '2 tabs')
    expect(await groupsOf(closed)).toEqual(['Open tabs', 'Recently closed'])
    expect(await closed.locator('.ts-group').last().textContent()).toBe('Recently closed')
    expect(await rowTitles(closed)).toContain('Delta window')
    await closed.keyboard.type('delta')
    await closingPress(closed, 'Enter')
    expect(await gone(app)).toBe(true)
    expect(await waitFor(() => chromePages(app).length === 2)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('looks right: marks, badges, long titles, a closed entry, at two window widths', async () => {
  if (SHOTS_DIR === undefined) return
  const { app, chrome } = await launched()
  try {
    await openPage(app, chrome, 'alpha', ['New Tab', 'Alpha report'])
    await openPage(app, chrome, 'radio', ['New Tab', 'Alpha report', 'Radio'])
    const started = await app.evaluate(async ({ webContents }, url) => await webContents.getAllWebContents().find((w) => w.getURL() === url)?.executeJavaScript('window.start()', true), pageUrl('radio'))
    expect(started).toBe('running')
    await openPage(app, chrome, 'long', ['New Tab', 'Alpha report', 'Radio', TITLES['long'] as string])
    await openPage(app, chrome, 'gamma', ['New Tab', 'Alpha report', 'Radio', TITLES['long'] as string, 'Gamma'])
    await chrome.locator('.tab', { hasText: 'Alpha report' }).click()
    await command(chrome, 'tab.pin')
    await command(chrome, 'window.new')
    expect(await waitFor(() => chromePages(app).length === 2)).toBe(true)
    const second = chromePages(app).find((page) => page !== chrome) as Page
    await openPage(app, second, 'delta', ['New Tab', 'Delta window'])
    // One entry on the closed stack, so the second group shows.
    await chrome.locator('.tab', { hasText: TITLES['long'] as string }).hover()
    await chrome.locator('.tab', { hasText: TITLES['long'] as string }).locator('.close').click()
    await expectStrip(chrome, ['Alpha report', 'New Tab', 'Radio', 'Gamma'])
    await chrome.locator('.tab', { hasText: 'Gamma' }).click()

    const list = await openList(app, pageUrl('gamma'))
    await shoot(app, chrome, list, 'empty-query')
    await list.keyboard.type('al')
    await shoot(app, chrome, list, 'filtered')
    await list.keyboard.press('Escape')
    await list.keyboard.press('End')
    await shoot(app, chrome, list, 'last-row')
    await list.keyboard.press('Escape').catch(() => {})
    expect(await gone(app)).toBe(true)

    // Narrow window: the list keeps its card inside the window.
    await app.evaluate(({ BaseWindow }) => { for (const window of BaseWindow.getAllWindows()) window.setSize(700, 600) })
    await delay(500)
    const narrow = await openList(app, pageUrl('gamma'))
    await shoot(app, chrome, narrow, 'narrow')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
