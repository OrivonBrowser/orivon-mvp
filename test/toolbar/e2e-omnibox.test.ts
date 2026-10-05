// The address bar's dropdown in the running shell: rows from history, bookmarks and open tabs under the bar,
// the top match finished inline as it is typed, the keyboard and the mouse choosing a row, and the ways it stays
// out of the way (a filled address loads as filled, a private window offers no history, no overlay exists before
// the first keystroke). The mouse choice is measured with a real pointer on the virtual display, since the
// overlay never takes focus. Set ORIVON_UI_SHOTS_DIR to also write screenshots in both colour schemes.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { SqliteHistoryStore } from '../../src/main/history/sqlite-history-store.js'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from '../support/launch-electron.mjs'
import { runCommand } from '../support/auth-support.js'
import { clearFocusLog, readFocusLog, startFocusLog } from '../support/focus-helpers.js'
import { html, launchShell, startServer } from '../support/qa-helpers.js'
import type { FixtureServer } from '../support/qa-helpers.js'
import { ABSENCE_SETTLE_MS, activeTabInfo, delay, popoverShown, tabIds, waitFor } from '../support/smoke-helpers.mjs'

const TEST_TIMEOUT_MS = 120_000
const SHOTS_DIR = process.env.ORIVON_UI_SHOTS_DIR
const DAY = 24 * 60 * 60 * 1000

let server: FixtureServer
let port = ''

const PAGES: Record<string, string> = {
  '/': 'Home page', '/alpha': 'Alpha notes', '/alphabet': 'Alphabet soup', '/beta': 'Beta journal', '/gamma': 'Gamma bookmark', '/delta': 'Delta tab'
}

beforeAll(async () => {
  server = await startServer((request, response) => {
    const title = PAGES[request.url ?? '/']
    html(response, `<!doctype html><title>${title ?? 'Not found'}</title><body style="font:16px sans-serif"><h1>${title ?? 'Not found'}</h1></body>`, title === undefined ? 404 : 200)
  })
  port = new URL(server.origin).port
})

afterAll(async () => {
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type App = ElectronApplication
const seedPages = async (dir: string, more: Record<string, string> = {}): Promise<void> => {
  await mkdir(dir, { recursive: true })
  const store = new SqliteHistoryStore(join(dir, 'history.db'))
  for (const [path, visits] of [['/alphabet', 3], ['/alpha', 1], ['/beta', 1]] as const) {
    for (let n = 0; n < visits; n += 1) store.record(`${server.origin}${path}`, PAGES[path] ?? '', Date.now() - (n + 1) * DAY)
  }
  store.close()
  writeFileSync(join(dir, 'bookmarks.json'), JSON.stringify([{ url: `${server.origin}/gamma`, title: 'Gamma bookmark', favicon: null }]))
  for (const [file, content] of Object.entries(more)) writeFileSync(join(dir, file), content)
}

const overlayOf = (app: App): Page | undefined => app.windows().find((w) => w.url().includes('overlay=omnibox'))
const shown = async (app: App): Promise<boolean> => await popoverShown(app, 'overlay=omnibox')

async function rowsOf (app: App): Promise<string[]> {
  const overlay = overlayOf(app)
  return overlay === undefined ? [] : await overlay.locator('.listbox-item').allInnerTexts()
}

/** Waits for the dropdown to list at least `count` rows, and answers them. */
async function waitForRows (app: App, count = 1): Promise<string[]> {
  expect(await waitFor(async () => (await shown(app)) && (await rowsOf(app)).length >= count)).toBe(true)
  return await rowsOf(app)
}

const field = async (chrome: Page): Promise<{ value: string, start: number | null, end: number | null, focused: boolean }> =>
  await chrome.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('#address') as HTMLInputElement
    return { value: input.value, start: input.selectionStart, end: input.selectionEnd, focused: document.activeElement === input }
  })

const selectedRow = async (app: App): Promise<string> =>
  (await overlayOf(app)?.locator('.listbox-item[aria-selected="true"]').innerText()) ?? ''

async function typeInBar (chrome: Page, text: string): Promise<void> {
  await chrome.click('#address')
  await chrome.keyboard.press('Control+A')
  await chrome.keyboard.type(text, { delay: 25 })
}

/** The addresses the tabs of the window hold, in view order. */
const tabAddresses = async (app: App): Promise<string[]> =>
  await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((wc) => wc.getURL()).filter((url) => url.startsWith('http://127.0.0.1')))

async function openTab (chrome: Page): Promise<void> {
  const before = (await tabIds(chrome)).length
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand('tab.new') })
  expect(await waitFor(async () => (await tabIds(chrome)).length === before + 1)).toBe(true)
}

async function go (app: App, chrome: Page, address: string): Promise<void> {
  await chrome.click('#address')
  await chrome.fill('#address', address)
  await chrome.press('#address', 'Enter')
  expect(await waitFor(async () => (await tabAddresses(app)).includes(address))).toBe(true)
  expect(await waitFor(async () => (await activeTabInfo(chrome)).address === address)).toBe(true)
}

/** A press of a real pointer button on the virtual display, at a point in screen pixels. */
function pressPointer (x: number, y: number, button: number): void {
  const script = [
    'import ctypes, sys, time',
    "x11 = ctypes.CDLL('libX11.so.6'); xtst = ctypes.CDLL('libXtst.so.6')",
    'x11.XOpenDisplay.restype = ctypes.c_void_p',
    'display = ctypes.c_void_p(x11.XOpenDisplay(None))',
    'x, y, button = [int(v) for v in sys.argv[1:4]]',
    'xtst.XTestFakeMotionEvent(display, -1, x, y, 0); x11.XFlush(display); time.sleep(0.15)',
    'xtst.XTestFakeButtonEvent(display, button, 1, 0); x11.XFlush(display); time.sleep(0.08)',
    'xtst.XTestFakeButtonEvent(display, button, 0, 0); x11.XFlush(display); time.sleep(0.1)',
    'x11.XCloseDisplay(display)'
  ].join('\n')
  execFileSync('python3', ['-c', script, String(Math.round(x)), String(Math.round(y)), String(button)], { timeout: 15_000 })
}

/** Where a row of the overlay is on the screen: the window's content, the overlay's place in it, the row in the overlay. */
async function rowOnScreen (app: App, row: ReturnType<Page['locator']>): Promise<{ x: number, y: number }> {
  const box = await row.boundingBox()
  if (box === null) throw new Error('the row has no box')
  const origin = await app.evaluate(({ BaseWindow }) => {
    const win = BaseWindow.getAllWindows()[0]
    if (win === undefined) return null
    const content = win.getContentBounds()
    const view = win.contentView.children.find((child) => (child as unknown as { webContents?: { getURL: () => string } }).webContents?.getURL().includes('overlay=omnibox') === true)
    const at = view?.getBounds()
    return at === undefined ? null : { x: content.x + at.x, y: content.y + at.y }
  })
  if (origin === null) throw new Error('the overlay is not in the window')
  return { x: origin.x + box.x + box.width / 2, y: origin.y + box.y + box.height / 2 }
}

async function shoot (app: App, chrome: Page, name: string): Promise<void> {
  if (SHOTS_DIR === undefined) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  const overlay = overlayOf(app)
  for (const scheme of ['light', 'dark'] as const) {
    await app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme }, scheme)
    await chrome.emulateMedia({ colorScheme: scheme })
    await overlay?.emulateMedia({ colorScheme: scheme })
    await delay(400)
    execFileSync('import', ['-window', 'root', join(SHOTS_DIR, `${name}-${scheme}.png`)])
    if (overlay !== undefined) await overlay.screenshot({ path: join(SHOTS_DIR, `${name}-rows-${scheme}.png`) })
  }
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'system' })
  await chrome.emulateMedia({ colorScheme: null })
  await overlay?.emulateMedia({ colorScheme: null })
}

it('builds no overlay before the first keystroke, and finishes what is typed inline without touching a filled address', async () => {
  const { app, chrome } = await launchShell({ seedProfile: async (dir: string) => { await seedPages(dir) } })
  try {
    expect(await app.evaluate(({ webContents }) => webContents.getAllWebContents().some((wc) => wc.getURL().includes('overlay=omnibox')))).toBe(false)
    // The chrome page exists, with its #address, before its module script has run and the address-suggest
    // module has given the field its combobox attributes: wait for that module, then click and read.
    expect(await waitFor(async () => (await chrome.evaluate(() => document.querySelector('#address')?.getAttribute('role') ?? null)) === 'combobox')).toBe(true)
    await chrome.click('#address')
    expect(await app.evaluate(({ webContents }) => webContents.getAllWebContents().some((wc) => wc.getURL().includes('overlay=omnibox')))).toBe(false)
    const roles = await chrome.evaluate(() => {
      const input = document.querySelector('#address') as HTMLInputElement
      return [input.getAttribute('role'), input.getAttribute('aria-expanded'), input.getAttribute('aria-autocomplete')]
    })
    expect(roles).toEqual(['combobox', 'false', 'both'])

    // Which events a fill and a real key press produce, measured in the field itself.
    await chrome.evaluate(() => {
      const input = document.querySelector('#address') as HTMLInputElement
      const log: string[] = []
      ;(window as unknown as { __inputs: string[] }).__inputs = log
      input.addEventListener('input', (event) => { log.push((event as InputEvent).inputType) })
    })

    // A fill followed by Enter loads exactly the address, although history would finish it to /alphabet.
    const filled = `${server.origin}/alpha`
    await chrome.fill('#address', filled)
    expect(await field(chrome)).toMatchObject({ value: filled, start: filled.length, end: filled.length })
    await chrome.press('#address', 'Enter')
    expect(await waitFor(async () => (await tabAddresses(app)).includes(filled))).toBe(true)
    expect(await tabAddresses(app)).not.toContain(`${server.origin}/alphabet`)
    const inputTypes = await chrome.evaluate(() => (window as unknown as { __inputs: string[] }).__inputs)
    console.log(`[omnibox probe] fill produced input events: ${JSON.stringify(inputTypes)}`)

    // Real typing: the bar shows the text and, selected after it, the rest of the host.
    await openTab(chrome)
    await chrome.evaluate(() => { (window as unknown as { __inputs: string[] }).__inputs.length = 0 })
    await typeInBar(chrome, '127')
    const rows = await waitForRows(app, 4)
    const completed = `127.0.0.1:${port}`
    expect(await waitFor(async () => (await field(chrome)).value === completed)).toBe(true)
    expect(await field(chrome)).toMatchObject({ start: 3, end: completed.length, focused: true })
    console.log(`[omnibox probe] typing produced input events: ${JSON.stringify(await chrome.evaluate(() => (window as unknown as { __inputs: string[] }).__inputs))}`)

    expect(rows[0]).toContain(completed)
    expect(rows.some((row) => row.includes('Gamma bookmark'))).toBe(true)
    expect(rows.some((row) => row.includes('Alphabet soup'))).toBe(true)
    expect(rows.some((row) => row.includes('Alpha notes') && row.includes('Switch to this tab'))).toBe(true)
    expect(rows.length).toBeLessThanOrEqual(8)
    expect(await overlayOf(app)?.locator('.omni-star').count()).toBeGreaterThan(0)
    expect(await chrome.evaluate(() => (document.querySelector('#address') as HTMLInputElement).getAttribute('aria-expanded'))).toBe('true')
    await shoot(app, chrome, 'omnibox-completion')

    // Backspace removes the completion first and offers none again.
    await chrome.keyboard.press('Backspace')
    expect(await field(chrome)).toMatchObject({ value: '127', start: 3, end: 3 })
    await waitForRows(app, 1)
    expect((await field(chrome)).value).toBe('127')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('moves the selection with the arrows, goes to the selected row on Enter, and puts the text back with Escape', async () => {
  const { app, chrome } = await launchShell({ seedProfile: async (dir: string) => { await seedPages(dir) } })
  try {
    await go(app, chrome, `${server.origin}/delta`)
    await openTab(chrome)
    await typeInBar(chrome, '127')
    await waitForRows(app, 4)
    const first = await selectedRow(app)
    expect(first).toContain(`127.0.0.1:${port}`)

    await chrome.keyboard.press('ArrowDown')
    expect(await waitFor(async () => (await selectedRow(app)).includes('Delta tab'))).toBe(true)
    // The rows are in another view, so the selected one is said through a live region of the chrome's own.
    expect(await waitFor(async () => (await chrome.locator('.address-live').textContent())?.includes('Delta tab') === true)).toBe(true)
    expect(await chrome.locator('#address').getAttribute('aria-activedescendant')).toBeNull()
    await chrome.keyboard.press('ArrowDown')
    expect(await waitFor(async () => (await selectedRow(app)).includes('Gamma bookmark'))).toBe(true)
    expect((await field(chrome)).value).toBe(`${server.origin}/gamma`)

    // Up past the first row wraps to the last, and back on the first row the typed text returns.
    await chrome.keyboard.press('ArrowUp')
    await chrome.keyboard.press('ArrowUp')
    expect(await waitFor(async () => (await selectedRow(app)).includes(`127.0.0.1:${port}`))).toBe(true)
    expect((await field(chrome)).value).toBe(`127.0.0.1:${port}`)
    await chrome.keyboard.press('ArrowUp')
    expect(await waitFor(async () => (await selectedRow(app)) !== first)).toBe(true)
    await chrome.keyboard.press('ArrowDown')
    await chrome.keyboard.press('ArrowDown')
    await chrome.keyboard.press('ArrowDown')
    expect(await waitFor(async () => (await selectedRow(app)).includes('Gamma bookmark'))).toBe(true)
    await shoot(app, chrome, 'omnibox-selected')

    await chrome.keyboard.press('Enter')
    expect(await waitFor(async () => (await tabAddresses(app)).includes(`${server.origin}/gamma`))).toBe(true)
    expect(await waitFor(async () => !(await shown(app)))).toBe(true)
    expect(await waitFor(async () => (await activeTabInfo(chrome)).address === `${server.origin}/gamma`)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('closes on the first Escape with the typed text back, and restores the page\'s address on the second', async () => {
  const { app, chrome } = await launchShell({ seedProfile: async (dir: string) => { await seedPages(dir) } })
  try {
    const address = `${server.origin}/gamma`
    await go(app, chrome, address)
    await typeInBar(chrome, '127')
    await waitForRows(app, 2)
    await chrome.keyboard.press('ArrowDown')
    await chrome.keyboard.press('Escape')
    expect(await waitFor(async () => !(await shown(app)))).toBe(true)
    expect((await field(chrome)).value).toBe('127')
    await chrome.keyboard.press('Escape')
    expect(await field(chrome)).toMatchObject({ value: address, start: 0, end: address.length })
    expect(await shown(app)).toBe(false)

    // The dropdown also closes when the field loses focus.
    await typeInBar(chrome, '127')
    await waitForRows(app, 2)
    await chrome.evaluate(() => { (document.querySelector('#address') as HTMLInputElement).blur() })
    expect(await waitFor(async () => !(await shown(app)))).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('goes to a row on a real click without the field losing what was typed first, and opens a background tab on a middle click', async () => {
  const { app, chrome } = await launchShell({ seedProfile: async (dir: string) => { await seedPages(dir) } })
  try {
    await go(app, chrome, `${server.origin}/delta`)
    await openTab(chrome)
    await chrome.evaluate(() => {
      const input = document.querySelector('#address') as HTMLInputElement
      const log: string[] = []
      ;(window as unknown as { __blurs: string[] }).__blurs = log
      input.addEventListener('blur', () => { log.push(input.value) })
    })
    await typeInBar(chrome, '127')
    await waitForRows(app, 4)
    const target = `${server.origin}/alphabet`
    const row = (overlayOf(app) as Page).locator('.listbox-item', { hasText: 'Alphabet soup' })
    const at = await rowOnScreen(app, row)
    pressPointer(at.x, at.y, 1)

    expect(await waitFor(async () => (await activeTabInfo(chrome)).address === target, 15_000)).toBe(true)
    expect(await waitFor(async () => !(await shown(app)))).toBe(true)
    const blurs = await chrome.evaluate(() => (window as unknown as { __blurs: string[] }).__blurs)
    const focus = await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((wc) => wc.isFocused()).map((wc) => wc.getURL().slice(0, 60)))
    console.log(`[omnibox probe] after a real click the field's value at each blur was ${JSON.stringify(blurs)}; focused: ${JSON.stringify(focus)}`)
    // The press navigated, and the field blurred at most once, afterwards (the page's own address had replaced the text by then).
    expect(blurs.length).toBeLessThanOrEqual(1)

    // A middle click opens the page in a tab behind this one.
    await openTab(chrome)
    await typeInBar(chrome, '127')
    await waitForRows(app, 4)
    const before = (await tabIds(chrome)).length
    const active = (await activeTabInfo(chrome)).activeId
    await (overlayOf(app) as Page).locator('.listbox-item', { hasText: 'Gamma bookmark' }).click({ button: 'middle' })
    expect(await waitFor(async () => (await tabIds(chrome)).length === before + 1)).toBe(true)
    expect(await waitFor(async () => (await tabAddresses(app)).includes(`${server.origin}/gamma`))).toBe(true)
    expect((await activeTabInfo(chrome)).activeId).toBe(active)
    expect(await waitFor(async () => !(await shown(app)))).toBe(true)

    // Ctrl with a plain click does the same.
    await openTab(chrome)
    await typeInBar(chrome, '127')
    await waitForRows(app, 4)
    const beforeCtrl = (await tabIds(chrome)).length
    const listed = await rowsOf(app)
    await (overlayOf(app) as Page).locator('.listbox-item').nth(listed.length - 1).click({ modifiers: ['Control'] })
    expect(await waitFor(async () => (await tabIds(chrome)).length === beforeCtrl + 1)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('switches to an open tab from its row and leaves no empty tab behind, and Alt+Enter opens a row in a new tab', async () => {
  const { app, chrome } = await launchShell({ seedProfile: async (dir: string) => { await seedPages(dir) } })
  try {
    await go(app, chrome, `${server.origin}/delta`)
    await openTab(chrome)
    const tabs = await tabIds(chrome)
    expect(tabs).toHaveLength(2)
    await typeInBar(chrome, 'delta')
    const rows = await waitForRows(app, 2)
    expect(rows.some((row) => row.includes('Switch to this tab'))).toBe(true)
    await chrome.keyboard.press('ArrowDown')
    expect(await waitFor(async () => (await selectedRow(app)).includes('Switch to this tab'))).toBe(true)
    await chrome.keyboard.press('Enter')
    expect(await waitFor(async () => (await tabIds(chrome)).length === 1)).toBe(true)
    expect((await tabIds(chrome))[0]).toBe(tabs[0])
    expect((await activeTabInfo(chrome)).activeId).toBe(tabs[0])
    expect(await waitFor(async () => !(await shown(app)))).toBe(true)

    // Alt+Enter on a history row opens it in a new foreground tab.
    await typeInBar(chrome, 'alphabet')
    await waitForRows(app, 2)
    await chrome.keyboard.press('ArrowDown')
    await chrome.keyboard.press('Alt+Enter')
    expect(await waitFor(async () => (await tabIds(chrome)).length === 2)).toBe(true)
    expect(await waitFor(async () => (await tabAddresses(app)).includes(`${server.origin}/alphabet`))).toBe(true)
    expect(await waitFor(async () => (await activeTabInfo(chrome)).address === `${server.origin}/alphabet`)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('searches for what follows a question mark, and the search key puts one in the field', async () => {
  const { app, chrome } = await launchShell({ seedProfile: async (dir: string) => { await seedPages(dir) } })
  try {
    // The command lands in the address module, which starts after the chrome page exists: wait for it first.
    expect(await waitFor(async () => (await chrome.evaluate(() => document.querySelector('#address')?.getAttribute('role') ?? null)) === 'combobox')).toBe(true)
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand('nav.focusSearch') })
    expect(await waitFor(async () => (await field(chrome)).value === '? ')).toBe(true)
    expect((await field(chrome)).focused).toBe(true)
    await chrome.keyboard.type('127.0.0.1', { delay: 25 })
    const rows = await waitForRows(app, 1)
    expect(rows[0]).toContain('127.0.0.1')
    expect(rows[0]).toContain('Search DuckDuckGo')
    // A forced search is never finished with a page.
    expect((await field(chrome)).value).toBe('? 127.0.0.1')
    await shoot(app, chrome, 'omnibox-search')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('shows the dropdown but finishes nothing while the setting is off', async () => {
  const settings = JSON.stringify({ version: 1, values: { 'addressBar.autocomplete': false } })
  const { app, chrome } = await launchShell({ seedProfile: async (dir: string) => { await seedPages(dir, { 'settings.json': settings }) } })
  try {
    await typeInBar(chrome, '127')
    const rows = await waitForRows(app, 3)
    expect(rows.some((row) => row.includes('Gamma bookmark'))).toBe(true)
    expect(await field(chrome)).toMatchObject({ value: '127', start: 3, end: 3 })
    await delay(400)
    expect((await field(chrome)).value).toBe('127')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('offers no history in a private window, only the tabs open in it', async () => {
  const { app, chrome } = await launchShell({ args: ['--orivon-private'] })
  try {
    await go(app, chrome, `${server.origin}/alpha`)
    await go(app, chrome, `${server.origin}/beta`)
    await openTab(chrome)
    await typeInBar(chrome, '127')
    const rows = await waitForRows(app, 2)
    expect(rows.some((row) => row.includes('Beta journal') && row.includes('Switch to this tab'))).toBe(true)
    // The page left behind in the first tab would be a history row in an ordinary window.
    expect(rows.some((row) => row.includes('Alpha notes'))).toBe(false)
    // Nothing finishes the text: a private session remembers no address.
    expect((await field(chrome)).value).toBe('127')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('the first keystroke builds the dropdown without the keyboard leaving the field', async () => {
  const { app, chrome } = await launchShell({ seedProfile: async (dir: string) => { await seedPages(dir) } })
  try {
    await startFocusLog(app)
    expect(await waitFor(async () => (await chrome.evaluate(() => document.querySelector('#address')?.getAttribute('role') ?? null)) === 'combobox')).toBe(true)
    await runCommand(chrome, 'nav.focusAddress')
    expect(await waitFor(async () => (await field(chrome)).focused)).toBe(true)
    await delay(ABSENCE_SETTLE_MS)
    await clearFocusLog(app)

    // The first query of the window builds the overlay: its page commits while the dropdown is being asked for.
    await chrome.keyboard.type('a', { delay: 25 })
    await waitForRows(app, 1)
    await delay(ABSENCE_SETTLE_MS)
    const taken = await readFocusLog(app)
    expect(taken.filter((url) => url === 'blank' || url.includes('overlay=omnibox'))).toEqual([])
    const chromeFocused = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((wc) => wc.getURL().includes('/renderer/index.html'))?.isFocused() === true)
    expect(chromeFocused).toBe(true)
    expect(await field(chrome)).toMatchObject({ focused: true })
    expect((await field(chrome)).value.startsWith('a')).toBe(true)

    // The rest of what is typed lands after the first letter, and the first letter is still there.
    await chrome.keyboard.type('bc', { delay: 25 })
    expect(await waitFor(async () => (await field(chrome)).value.startsWith('abc'))).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
