// Reopen closed tab in the running shell: a tab returns where it was, in front; repeated presses walk back
// through everything closed, tabs and windows alike; a private window keeps the stack in memory and writes no
// session file; the session file follows the open windows; and a restart offers the last window again.
// Set ORIVON_UI_SHOTS_DIR to also write screenshots of the menu row.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from '../support/launch-electron.mjs'
import type { CommandId } from '../../src/main/shortcuts/commands.js'
import { bindingOf, pressCommand, shownBinding } from '../support/e2e-helpers.js'
import { delay, evaluateRetrying, findChrome, HERMETIC_RESOLVER, popoverShown, waitFor } from '../support/smoke-helpers.mjs'

const TEST_TIMEOUT_MS = 90_000
const SHOTS_DIR = process.env.ORIVON_UI_SHOTS_DIR
const SILENT = { args: [HERMETIC_RESOLVER, '--alsa-output-device=null'], env: { PULSE_SERVER: 'unix:/nonexistent' } }

let server: Server
let origin = ''
const hits = new Map<string, number>()

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? '/'
    hits.set(path, (hits.get(path) ?? 0) + 1)
    response.setHeader('content-type', 'text/html')
    response.end(`<!doctype html><title>page ${path.slice(1)}</title><p>${path}</p>`)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface StripTab { id: string, title: string, active: boolean, pinned: boolean }

const chromePages = (app: ElectronApplication): Page[] => app.windows().filter((w) => w.url().endsWith('/renderer/index.html'))

async function launched (extra: { args?: string[], reuseProfile?: string } = {}): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({ appPath: '.', ...SILENT, args: [...SILENT.args, ...(extra.args ?? [])], ...(extra.reuseProfile === undefined ? {} : { reuseProfile: extra.reuseProfile }) })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

const strip = async (chrome: Page): Promise<StripTab[]> => await evaluateRetrying(chrome, () =>
  Array.from(document.querySelectorAll<HTMLElement>('.tab')).map((el) => ({
    id: el.dataset['id'] ?? '', title: el.querySelector('.title')?.textContent ?? '', active: el.classList.contains('active'), pinned: el.classList.contains('pinned')
  })))

const titles = async (chrome: Page): Promise<string[]> => (await strip(chrome)).map((tab) => tab.title)

async function waitTitles (chrome: Page, expected: string[]): Promise<void> {
  let seen: string[] = []
  const ok = await waitFor(async () => { seen = await titles(chrome); return JSON.stringify(seen) === JSON.stringify(expected) })
  expect(seen).toEqual(expected)
  expect(ok).toBe(true)
}

/** A restored tab can show its address for a moment before its page title arrives, so the title is waited for. */
async function waitActiveTitle (chrome: Page, expected: string): Promise<void> {
  let seen: string | undefined
  await waitFor(async () => { seen = (await strip(chrome)).find((tab) => tab.active)?.title; return seen === expected })
  expect(seen).toBe(expected)
}

async function open (chrome: Page, name: string, expected: string[]): Promise<void> {
  await chrome.evaluate((url) => { (window as unknown as { orivonShell: { newTab: (u: string) => void } }).orivonShell.newTab(url) }, `${origin}/${name}`)
  await waitTitles(chrome, expected)
}

async function close (chrome: Page, title: string): Promise<void> {
  const tab = (await strip(chrome)).find((candidate) => candidate.title === title)
  expect(tab, title).toBeDefined()
  // Closing a window's last tab closes the window, and with it this page, which Playwright may see before the call returns.
  await chrome.evaluate((id) => { (window as unknown as { orivonShell: { closeTab: (i: string) => void } }).orivonShell.closeTab(id) }, tab?.id ?? '')
    .catch((error: unknown) => { if (!/Target page, context or browser has been closed/.test(String(error))) throw error })
}

/** The key goes to the page itself, so the page has to exist and be past loading. */
async function pressOnPage (app: ElectronApplication, url: string, command: CommandId): Promise<void> {
  expect(await waitFor(async () => await app.evaluate(({ webContents }, part) => webContents.getAllWebContents().some((wc) => wc.getURL() === part && !wc.isLoading()), url))).toBe(true)
  await pressCommand(app, url, command)
}

const command = async (chrome: Page, id: string): Promise<void> => {
  await chrome.evaluate((commandId) => { (window as unknown as { orivonShell: { runCommand: (i: string) => void } }).orivonShell.runCommand(commandId) }, id)
}

const userDataOf = async (app: ElectronApplication): Promise<string> => await app.evaluate(({ app: electron }) => electron.getPath('userData'))

it('brings a closed tab back where it was, in front, and walks back through several presses', async () => {
  const { app, chrome } = await launched()
  try {
    await waitTitles(chrome, ['New Tab'])
    await open(chrome, 'a', ['New Tab', 'page a'])
    await open(chrome, 'b', ['New Tab', 'page a', 'page b'])
    await open(chrome, 'c', ['New Tab', 'page a', 'page b', 'page c'])

    await close(chrome, 'page b')
    await waitTitles(chrome, ['New Tab', 'page a', 'page c'])
    await pressOnPage(app, `${origin}/c`, 'tab.reopen')
    await waitTitles(chrome, ['New Tab', 'page a', 'page b', 'page c'])
    await waitActiveTitle(chrome, 'page b')

    await close(chrome, 'page c')
    await close(chrome, 'page a')
    await waitTitles(chrome, ['New Tab', 'page b'])
    await pressOnPage(app, `${origin}/b`, 'tab.reopen')
    await waitTitles(chrome, ['New Tab', 'page a', 'page b'])
    await waitActiveTitle(chrome, 'page a')
    await pressOnPage(app, `${origin}/a`, 'tab.reopen')
    await waitTitles(chrome, ['New Tab', 'page a', 'page b', 'page c'])

    // Nothing left to reopen: nothing happens.
    await command(chrome, 'tab.reopen')
    await command(chrome, 'tab.reopen')
    await delay(600)
    await waitTitles(chrome, ['New Tab', 'page a', 'page b', 'page c'])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('does not put the new-tab page on the stack, and leaves the strip alone when there is nothing to bring back', async () => {
  const { app, chrome } = await launched()
  try {
    await open(chrome, 'a', ['New Tab', 'page a'])
    await close(chrome, 'New Tab')
    await waitTitles(chrome, ['page a'])
    await command(chrome, 'tab.reopen')
    await delay(600)
    await waitTitles(chrome, ['page a'])
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('gives the tab its back list again, loading the page once', async () => {
  const { app, chrome } = await launched()
  try {
    await open(chrome, 'h1', ['New Tab', 'page h1'])
    const pageUrl = `${origin}/h2`
    await chrome.fill('#address', pageUrl)
    await chrome.press('#address', 'Enter')
    await waitTitles(chrome, ['New Tab', 'page h2'])
    await close(chrome, 'page h2')
    await waitTitles(chrome, ['New Tab'])
    hits.set('/h2', 0)

    await command(chrome, 'tab.reopen')
    await waitTitles(chrome, ['New Tab', 'page h2'])
    expect(await waitFor(async () => await evaluateRetrying(chrome, () => document.querySelector<HTMLButtonElement>('#back')?.disabled === false))).toBe(true)
    await delay(800)
    expect(hits.get('/h2')).toBe(1)
    // The list is whole: the entry before it is there, and going forward again lands on the same page.
    await chrome.click('#back')
    await waitTitles(chrome, ['New Tab', 'page h1'])
    expect(await waitFor(async () => await evaluateRetrying(chrome, () => document.querySelector<HTMLButtonElement>('#forward')?.disabled === false))).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('brings a closed window back with all its tabs, and reopens a tab in the window it left when that is another one', async () => {
  const { app, chrome } = await launched()
  try {
    await command(chrome, 'window.new')
    expect(await waitFor(() => chromePages(app).length === 2)).toBe(true)
    const second = chromePages(app).find((page) => page !== chrome) as Page
    await waitTitles(second, ['New Tab'])
    await open(second, 'a', ['New Tab', 'page a'])
    await open(second, 'b', ['New Tab', 'page a', 'page b'])

    await app.evaluate(({ BaseWindow }) => { [...BaseWindow.getAllWindows()].sort((x, y) => y.id - x.id)[0]?.close() })
    expect(await waitFor(() => chromePages(app).length === 1)).toBe(true)

    await command(chrome, 'tab.reopen')
    expect(await waitFor(() => chromePages(app).length === 2)).toBe(true)
    const again = chromePages(app).find((page) => page !== chrome) as Page
    await waitTitles(again, ['page a', 'page b'])
    await waitActiveTitle(again, 'page b')

    // A tab closed in the second window returns there even when the key is pressed in the first.
    await close(again, 'page a')
    await waitTitles(again, ['page b'])
    await command(chrome, 'tab.reopen')
    await waitTitles(again, ['page a', 'page b'])
    await waitTitles(chrome, ['New Tab'])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('works in a private window, in memory, and writes no session file', async () => {
  const { app, chrome } = await launched({ args: ['--orivon-private'] })
  let dir = ''
  try {
    dir = await userDataOf(app)
    expect(await waitFor(async () => (await strip(chrome)).length === 1)).toBe(true)
    await open(chrome, 'a', [(await titles(chrome))[0] ?? '', 'page a'])
    const before = await titles(chrome)
    await close(chrome, 'page a')
    await waitFor(async () => (await strip(chrome)).length === 1)
    await command(chrome, 'tab.reopen')
    await waitTitles(chrome, before)
    await delay(900)
    expect(existsSync(join(dir, 'session.json'))).toBe(false)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('writes the open windows to session.json, without the new-tab page, and marks an orderly end', async () => {
  const { app, chrome } = await launched()
  let dir = ''
  try {
    dir = await userDataOf(app)
    await open(chrome, 'a', ['New Tab', 'page a'])
    await open(chrome, 'b', ['New Tab', 'page a', 'page b'])
    await delay(700)
    const file = join(dir, 'session.json')
    expect(await waitFor(() => existsSync(file))).toBe(true)
    const session = JSON.parse(await readFile(file, 'utf8')) as { version: number, clean: boolean, windows: Array<{ active: number, tabs: Array<{ url: string, title: string, pinned: boolean }>, bounds: { width: number } }> }
    expect(session.version).toBe(1)
    expect(session.clean).toBe(false)
    expect(session.windows).toHaveLength(1)
    expect(session.windows[0]?.tabs.map((tab) => tab.url)).toEqual([`${origin}/a`, `${origin}/b`])
    expect(session.windows[0]?.tabs.map((tab) => tab.title)).toEqual(['page a', 'page b'])
    expect(session.windows[0]?.active).toBe(1)
    expect(session.windows[0]?.bounds.width).toBeGreaterThan(300)
    // Page state never reaches the file.
    expect(JSON.stringify(session)).not.toContain('pageState')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('offers the previous session\'s last window after a restart, and the file said it ended in order', async () => {
  const first = await launched()
  let dir = ''
  try {
    dir = await userDataOf(first.app)
    await open(first.chrome, 'a', ['New Tab', 'page a'])
    await open(first.chrome, 'b', ['New Tab', 'page a', 'page b'])
    await command(first.chrome, 'window.new')
    expect(await waitFor(() => chromePages(first.app).length === 2)).toBe(true)
    const second = chromePages(first.app).find((page) => page !== first.chrome) as Page
    await open(second, 'c', ['New Tab', 'page c'])
    await delay(700)
    // A quit with two windows keeps both.
    const file = join(dir, 'session.json')
    await first.app.evaluate(({ app }) => { app.quit() }).catch(() => {})
    const ended = async (): Promise<boolean> => { try { return (JSON.parse(await readFile(file, 'utf8')) as { clean: boolean }).clean } catch { return false } }
    expect(await waitFor(ended, 15_000)).toBe(true)
    const session = JSON.parse(await readFile(file, 'utf8')) as { clean: boolean, windows: Array<{ tabs: unknown[] }> }
    expect(session.clean).toBe(true)
    expect(session.windows.map((window) => window.tabs.length).sort()).toEqual([1, 2])
  } finally {
    await closeElectron(first.app, { keepProfile: true })
  }
  const again = await launched({ reuseProfile: dir })
  try {
    await waitTitles(again.chrome, ['New Tab'])
    await command(again.chrome, 'tab.reopen')
    expect(await waitFor(() => chromePages(again.app).length === 2)).toBe(true)
    const back = chromePages(again.app).find((page) => page !== again.chrome) as Page
    expect(await waitFor(async () => (await titles(back)).includes('page c') || (await titles(back)).includes('page b'))).toBe(true)
    // The window before it comes back on the next press.
    await command(again.chrome, 'tab.reopen')
    expect(await waitFor(() => chromePages(again.app).length === 3)).toBe(true)
  } finally {
    await closeElectron(again.app)
  }
}, TEST_TIMEOUT_MS * 2)

it('keeps the tab whose closing closed the last window in the session file', async () => {
  const { app, chrome } = await launched()
  let dir = ''
  try {
    dir = await userDataOf(app)
    await open(chrome, 'a', ['New Tab', 'page a'])
    await close(chrome, 'New Tab')
    await waitTitles(chrome, ['page a'])
    await close(chrome, 'page a')
    const file = join(dir, 'session.json')
    const ended = async (): Promise<boolean> => { try { return (JSON.parse(await readFile(file, 'utf8')) as { clean: boolean }).clean } catch { return false } }
    expect(await waitFor(ended, 15_000)).toBe(true)
    const session = JSON.parse(await readFile(file, 'utf8')) as { windows: Array<{ tabs: Array<{ url: string }> }> }
    expect(session.windows.map((window) => window.tabs.map((tab) => tab.url))).toEqual([[`${origin}/a`]])
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('shows in the main menu what would come back, under History, and nothing when there is none', async () => {
  const { app, chrome } = await launched()
  try {
    const openMenu = async (): Promise<Page> => {
      await chrome.click('#menu')
      expect(await waitFor(async () => await popoverShown(app, 'overlay=menu'))).toBe(true)
      expect(await waitFor(() => app.windows().some((w) => w.url().includes('overlay=menu')))).toBe(true)
      const menu = app.windows().find((w) => w.url().includes('overlay=menu')) as Page
      await menu.waitForSelector('.menu-row')
      return menu
    }
    const closeMenu = async (menu: Page): Promise<void> => {
      await menu.keyboard.press('Escape')
      expect(await waitFor(async () => !(await popoverShown(app, 'overlay=menu')))).toBe(true)
      await delay(350)
    }
    const shoot = async (menu: Page, name: string): Promise<void> => {
      if (SHOTS_DIR === undefined) return
      mkdirSync(SHOTS_DIR, { recursive: true })
      for (const scheme of ['light', 'dark'] as const) {
        await menu.emulateMedia({ colorScheme: scheme })
        await delay(250)
        await menu.screenshot({ path: join(SHOTS_DIR, `${name}-${scheme}.png`) })
      }
      await menu.emulateMedia({ colorScheme: null })
    }

    let menu = await openMenu()
    const labels = await menu.locator('.menu-row .menu-label').allTextContents()
    const at = labels.indexOf('Reopen closed tab')
    expect(at).toBe(labels.indexOf('History') + 1)
    expect(await menu.locator('.menu-row', { hasText: 'Reopen closed tab' }).locator('.menu-hint').count()).toBe(0)
    expect(await menu.locator('.menu-row', { hasText: 'Reopen closed tab' }).locator('.menu-keys').textContent()).toBe(shownBinding(bindingOf('tab.reopen')))
    await shoot(menu, 'reopen-menu-empty')
    await closeMenu(menu)

    await open(chrome, 'invoice', ['New Tab', 'page invoice'])
    await close(chrome, 'page invoice')
    await waitTitles(chrome, ['New Tab'])
    menu = await openMenu()
    const row = menu.locator('.menu-row', { hasText: 'Reopen closed tab' })
    expect(await row.textContent()).toContain('page invoice')
    // The hint goes under the label: the shortcut keeps its column.
    expect(await row.locator('.menu-keys').textContent()).toBe(shownBinding(bindingOf('tab.reopen')))
    await shoot(menu, 'reopen-menu-hint')
    await closeMenu(menu)

    // A long title is cut by the menu, not wrapped or overflowing.
    await open(chrome, 'x'.repeat(200), ['New Tab', `page ${'x'.repeat(200)}`])
    await close(chrome, `page ${'x'.repeat(200)}`)
    await waitTitles(chrome, ['New Tab'])
    menu = await openMenu()
    await shoot(menu, 'reopen-menu-long')
    expect(await menu.locator('.menu-row', { hasText: 'Reopen closed tab' }).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await closeMenu(menu)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
