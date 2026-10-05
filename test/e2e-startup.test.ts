// What a start opens: the new tab page, last session's windows, or the listed pages; the address on the
// command line added to either; the Settings rows that choose it; and the bar that offers the last session back
// after a run that did not end cleanly. Set ORIVON_UI_SHOTS_DIR to also write screenshots of the new surfaces.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { closeElectron, assertNoElectronSurvivors, mainOutput } from './support/launch-electron.mjs'
import { html, launchShell, startServer, type FixtureServer } from './support/qa-helpers.js'
import { ABSENCE_SETTLE_MS, delay, evaluateRetrying, popoverShown, waitFor } from './support/smoke-helpers.mjs'

const SHOTS_DIR = process.env['ORIVON_UI_SHOTS_DIR']
const TEST_TIMEOUT_MS = 90_000

let server: FixtureServer
beforeAll(async () => {
  server = await startServer((request, response) => {
    const name = (request.url ?? '/').replace(/^\//, '') || 'root'
    // A server that never answers: its tab has committed nothing when the session is written.
    if (name === 'hang') return
    html(response, `<!doctype html><meta charset="utf-8"><title>page ${name}</title><body><p>${name}</p>`)
  })
})

afterAll(async () => {
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface SavedTab { url: string, title?: string, pinned?: boolean }
interface SavedWindow { bounds?: { x: number, y: number, width: number, height: number }, maximized?: boolean, active: number, tabs: unknown[] }
const url = (name: string): string => `${server.origin}/${name}`
const tabOf = (name: string, pinned = false): SavedTab => ({ url: url(name), title: `page ${name}`, pinned })

const seed = (files: { settings?: Record<string, unknown>, session?: string }) => async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true })
  if (files.settings !== undefined) await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: files.settings }))
  if (files.session !== undefined) await writeFile(join(dir, 'session.json'), files.session)
}
const sessionText = (windows: SavedWindow[], clean = true): string => JSON.stringify({ version: 1, clean, windows })
const sized = (x: number, y: number): NonNullable<SavedWindow['bounds']> => ({ x, y, width: 1000, height: 700 })

interface StripTab { title: string, active: boolean, pinned: boolean }
const chromePages = (app: ElectronApplication): Page[] => app.windows().filter((w) => w.url().endsWith('/renderer/index.html'))
const strip = async (chrome: Page): Promise<StripTab[]> => await evaluateRetrying(chrome, () =>
  Array.from(document.querySelectorAll<HTMLElement>('.tab')).map((el) => ({
    title: el.querySelector('.title')?.textContent ?? '', active: el.classList.contains('active'), pinned: el.classList.contains('pinned')
  })))
const titles = async (chrome: Page): Promise<string[]> => (await strip(chrome)).map((tab) => tab.title)

async function waitTitles (chrome: Page, expected: string[]): Promise<void> {
  let seen: string[] = []
  await waitFor(async () => { seen = await titles(chrome); return JSON.stringify(seen) === JSON.stringify(expected) })
  expect(seen).toEqual(expected)
}

/** The window whose strip holds a tab with this title: which window is first in `app.windows()` is not a contract. */
async function windowShowing (app: ElectronApplication, title: string): Promise<Page> {
  let found: Page | undefined
  await waitFor(async () => {
    for (const page of chromePages(app)) if ((await titles(page)).includes(title)) { found = page; return true }
    return false
  })
  expect(found, `a window showing ${title}`).toBeDefined()
  return found as Page
}

const newTab = async (chrome: Page, address: string): Promise<void> => {
  await chrome.evaluate((target) => { (window as unknown as { orivonShell: { newTab: (u: string) => void } }).orivonShell.newTab(target) }, address)
}
const command = async (chrome: Page, id: string): Promise<void> => {
  await chrome.evaluate((commandId) => { (window as unknown as { orivonShell: { runCommand: (i: string) => void } }).orivonShell.runCommand(commandId) }, id)
}
const userDataOf = async (app: ElectronApplication): Promise<string> => await app.evaluate(({ app: electron }) => electron.getPath('userData'))
const windowCount = async (app: ElectronApplication): Promise<number> => await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length)
const allBounds = async (app: ElectronApplication): Promise<Array<{ width: number, height: number }>> =>
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().map((window) => { const { width, height } = window.getBounds(); return { width, height } }))

async function openSettings (app: ElectronApplication, chrome: Page): Promise<Page> {
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (p: string, path?: string) => void } }).orivonShell.openInternal('settings', '/startup') })
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
  const page = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
  await page.waitForSelector('#row-startup-mode select')
  return page
}

async function shoot (page: Page, name: string): Promise<void> {
  if (SHOTS_DIR === undefined) return
  await mkdir(SHOTS_DIR, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await delay(250)
    await page.screenshot({ path: join(SHOTS_DIR, `${name}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: null })
}

const items = async (settings: Page): Promise<string[]> => await settings.locator('.page-list-item .page-list-address').evaluateAll((els) => els.map((el) => el.getAttribute('title') ?? ''))
const savedPages = async (dir: string): Promise<string> => {
  try { return ((JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')) as { values: Record<string, unknown> }).values['startup.pages'] as string | undefined) ?? '' } catch { return '' }
}

it('opens one new tab page on a fresh profile, and on the default choice whatever the last session held', async () => {
  const { app, chrome } = await launchShell({ seedProfile: seed({ session: sessionText([{ active: 0, tabs: [tabOf('a')] }]) }) })
  try {
    await waitTitles(chrome, ['New Tab'])
    expect(chromePages(app)).toHaveLength(1)
    expect(await windowCount(app)).toBe(1)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('opens the listed pages as the first window\'s tabs, the first in front', async () => {
  const pages = [url('a'), url('b')].join('\n')
  const { app, chrome } = await launchShell({ seedProfile: seed({ settings: { 'startup.mode': 'pages', 'startup.pages': pages } }) })
  try {
    await waitTitles(chrome, ['page a', 'page b'])
    expect((await strip(chrome)).map((tab) => tab.active)).toEqual([true, false])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('opens the new tab page for the pages choice with no pages', async () => {
  const { app, chrome } = await launchShell({ seedProfile: seed({ settings: { 'startup.mode': 'pages' } }) })
  try {
    await waitTitles(chrome, ['New Tab'])
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('continues with every window of the last session: order, the pinned tab, the tab that was in front, each window\'s size', async () => {
  const session = sessionText([
    { bounds: sized(40, 40), active: 1, tabs: [tabOf('a', true), tabOf('b')] },
    { bounds: { x: 120, y: 90, width: 900, height: 640 }, active: 0, tabs: [tabOf('c')] }
  ])
  const { app, chrome } = await launchShell({ seedProfile: seed({ settings: { 'startup.mode': 'continue' }, session }) })
  try {
    expect(await waitFor(() => chromePages(app).length === 2)).toBe(true)
    const first = await windowShowing(app, 'page a')
    await waitTitles(first, ['page a', 'page b'])
    expect((await strip(first)).map((tab) => [tab.pinned, tab.active])).toEqual([[true, false], [false, true]])
    const second = await windowShowing(app, 'page c')
    await waitTitles(second, ['page c'])
    expect(await windowCount(app)).toBe(2)
    expect(chromePages(app)).toContain(chrome)
    expect(await waitFor(async () => (await allBounds(app)).some((b) => b.width === 900 && b.height === 640))).toBe(true)
    // The windows came back once, so Reopen has nothing of this session left to offer.
    await command(first, 'tab.reopen')
    await delay(ABSENCE_SETTLE_MS)
    expect(await windowCount(app)).toBe(2)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('drops a tab whose address is refused and a window that is not one, and never throws on a damaged file', async () => {
  const session = JSON.stringify({ version: 1, clean: true, windows: [
    { active: 0, tabs: [{ url: 'javascript:alert(1)', title: 'x' }, { url: 'file:///etc/passwd' }, 5, null, tabOf('a')] },
    5, { tabs: 'nope' }, { active: 'x', tabs: [] }
  ] })
  const { app, chrome } = await launchShell({ seedProfile: seed({ settings: { 'startup.mode': 'continue' }, session }) })
  try {
    await waitTitles(chrome, ['page a'])
    await delay(ABSENCE_SETTLE_MS)
    expect(await windowCount(app)).toBe(1)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
  const broken = await launchShell({ seedProfile: seed({ settings: { 'startup.mode': 'continue' }, session: 'not json {' }) })
  try {
    await waitTitles(broken.chrome, ['New Tab'])
  } finally {
    await closeElectron(broken.app)
  }
}, TEST_TIMEOUT_MS * 2)

it('keeps a restored tab whose page has not loaded in the session written at quit', async () => {
  const session = sessionText([{ active: 0, tabs: [tabOf('a'), tabOf('hang')] }])
  const { app, chrome } = await launchShell({ seedProfile: seed({ settings: { 'startup.mode': 'continue' }, session }) })
  let dir = ''
  try {
    await waitTitles(chrome, ['page a', 'page hang'])
    dir = await userDataOf(app)
    // Past the recorder's first write: nothing of the hung page has committed yet.
    await delay(ABSENCE_SETTLE_MS * 2)
  } finally {
    await closeElectron(app, { keepProfile: true })
  }
  try {
    const written = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8')) as { windows: Array<{ tabs: Array<{ url: string }> }> }
    expect(written.windows[0]?.tabs.map((tab) => tab.url)).toEqual([url('a'), url('hang')])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, TEST_TIMEOUT_MS)

it('adds a launch address to the restored tabs, in front', async () => {
  const session = sessionText([{ active: 0, tabs: [tabOf('a'), tabOf('b')] }])
  const { app, chrome } = await launchShell({ args: [url('x')], seedProfile: seed({ settings: { 'startup.mode': 'continue' }, session }) })
  try {
    await waitTitles(chrome, ['page a', 'page b', 'page x'])
    expect((await strip(chrome)).map((tab) => tab.active)).toEqual([false, false, true])
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

// A private runtime has no session file to read (its store is empty), so this is about what a private start shows: one tab and no
// offer. That it ignores the start-up choice when there is a session is the unit test of planStartup.
it('opens a private session on one tab with no restore bar', async () => {
  const session = sessionText([{ active: 0, tabs: [tabOf('a')] }], false)
  const { app, chrome } = await launchShell({ args: ['--orivon-private'], seedProfile: seed({ settings: { 'startup.mode': 'continue' }, session }) })
  try {
    await waitFor(async () => (await strip(chrome)).length === 1)
    await delay(ABSENCE_SETTLE_MS * 2)
    expect(await titles(chrome)).toHaveLength(1)
    expect(await titles(chrome)).not.toContain('page a')
    expect(await windowCount(app)).toBe(1)
    expect(await popoverShown(app, 'overlay=restore')).toBe(false)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('chooses the start from Settings, with its help, and keeps a list of pages: add, refuse, remove, empty', async () => {
  const { app, chrome } = await launchShell()
  try {
    const dir = await userDataOf(app)
    const settings = await openSettings(app, chrome)
    expect(await settings.locator('#row-startup-pages').count()).toBe(0)
    expect(await settings.locator('#row-startup-mode .row-help').count()).toBe(0)
    await shoot(settings, 'settings-startup-new-tab')

    // By key, so the select really has focus: a redraw must give it back.
    await settings.focus('#row-startup-mode select')
    await settings.keyboard.press('ArrowDown')
    await settings.waitForSelector('#row-startup-mode .row-help')
    expect(await settings.textContent('#row-startup-mode .row-help')).toBe('Your windows and tabs from last time reopen. Private windows are never reopened.')
    expect(await settings.locator('#row-startup-pages').count()).toBe(0)
    await shoot(settings, 'settings-startup-continue')

    await settings.keyboard.press('ArrowDown')
    await settings.waitForSelector('#row-startup-pages .page-list')
    expect(await settings.textContent('#row-startup-mode .row-help')).toBe('These pages open in the first window.')
    // The choice still has the keyboard after the page drew itself again.
    expect(await settings.evaluate(() => document.activeElement?.tagName)).toBe('SELECT')
    expect(await settings.textContent('#row-startup-pages .empty-state')).toContain('No pages yet. Orivon opens the new tab page until you add one.')
    await shoot(settings, 'settings-startup-pages-empty')

    const field = '#row-startup-pages .page-list-field'
    await settings.fill(field, 'example.com')
    await settings.press(field, 'Enter')
    await settings.waitForSelector('.page-list-item')
    expect(await items(settings)).toEqual(['https://example.com/'])
    expect(await settings.inputValue(field)).toBe('')
    expect(await settings.evaluate(() => document.activeElement?.classList.contains('page-list-field'))).toBe(true)
    expect(await waitFor(async () => (await savedPages(dir)) === 'https://example.com/')).toBe(true)

    // A second spelling of a page already listed changes nothing and says nothing.
    await settings.fill(field, 'https://example.com')
    await settings.press(field, 'Enter')
    await settings.waitForFunction((selector) => (document.querySelector<HTMLInputElement>(selector)?.value ?? 'x') === '', field)
    expect(await items(settings)).toEqual(['https://example.com/'])
    expect(await settings.textContent('#row-startup-pages .problem')).toBe('')

    await settings.fill(field, 'not a url')
    await settings.click('#row-startup-pages .page-list-add .btn')
    await settings.waitForFunction(() => (document.querySelector('#row-startup-pages .problem')?.textContent ?? '') !== '')
    expect(await settings.textContent('#row-startup-pages .problem')).toBe('Enter a web address, like https://example.com')
    expect(await settings.getAttribute(field, 'aria-invalid')).toBe('true')
    expect(await items(settings)).toEqual(['https://example.com/'])
    await shoot(settings, 'settings-startup-pages-invalid')

    await settings.fill(field, 'other.example')
    await settings.click('#row-startup-pages .page-list-add .btn')
    await settings.waitForFunction(() => document.querySelectorAll('.page-list-item').length === 2)
    // Remove the first: focus moves to the remove button now in its place.
    await settings.hover('.page-list-item')
    expect(await settings.getAttribute('.page-list-remove', 'aria-label')).toBe('Remove https://example.com/')
    await settings.click('.page-list-remove')
    await settings.waitForFunction(() => document.querySelectorAll('.page-list-item').length === 1)
    expect(await items(settings)).toEqual(['https://other.example/'])
    expect(await settings.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Remove https://other.example/')
    await settings.click('.page-list-remove')
    await settings.waitForSelector('#row-startup-pages .empty-state')
    expect(await settings.evaluate(() => document.activeElement?.classList.contains('page-list-field'))).toBe(true)
    expect(await waitFor(async () => (await savedPages(dir)) === '')).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('takes the pages open now, leaves out Settings, and refuses a ninth page', async () => {
  const { app, chrome } = await launchShell({ seedProfile: seed({ settings: { 'startup.mode': 'pages' } }) })
  try {
    await waitTitles(chrome, ['New Tab'])
    await newTab(chrome, url('a'))
    await newTab(chrome, url('b'))
    await waitTitles(chrome, ['New Tab', 'page a', 'page b'])
    const settings = await openSettings(app, chrome)
    const use = '#row-startup-pages .link-btn'
    await settings.waitForSelector(`${use}:not([disabled])`)
    await shoot(settings, 'settings-startup-pages-open-now')
    await settings.click(use)
    await settings.waitForFunction(() => document.querySelectorAll('.page-list-item').length === 2)
    expect(await items(settings)).toEqual([`${url('a')}`, `${url('b')}`])

    const eight = Array.from({ length: 8 }, (_, n) => `https://${String(n)}.example/`)
    await settings.evaluate(async (list) => {
      await (window as unknown as { orivonInternal: { request: (d: string, c: unknown) => Promise<unknown> } }).orivonInternal.request('settings', { type: 'set', key: 'startup.pages', value: list.join('\n') })
    }, eight)
    // A change from elsewhere waits while the field has focus, as a draft in it would be lost.
    await settings.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur() })
    await settings.waitForFunction(() => document.querySelectorAll('.page-list-item').length === 8)
    // A full list says so before anything is typed: the field and Add are off, with the limit in the field.
    expect(await settings.isDisabled('#row-startup-pages .page-list-field')).toBe(true)
    expect(await settings.isDisabled('#row-startup-pages .page-list-add .btn')).toBe(true)
    expect(await settings.getAttribute('#row-startup-pages .page-list-field', 'placeholder')).toBe('You can open up to 8 pages')
    expect(await items(settings)).toEqual(eight)
    await shoot(settings, 'settings-startup-pages-full')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('says so when no web page is open, and takes one opened after Settings was', async () => {
  const { app, chrome } = await launchShell({ seedProfile: seed({ settings: { 'startup.mode': 'pages' } }) })
  try {
    const settings = await openSettings(app, chrome)
    const use = '#row-startup-pages .link-btn'
    await settings.waitForSelector(use)
    await settings.click(use)
    await settings.waitForFunction(() => (document.querySelector('#row-startup-pages .problem')?.textContent ?? '') !== '')
    expect(await settings.textContent('#row-startup-pages .problem')).toBe('No other pages are open right now.')
    expect(await items(settings)).toEqual([])
    // The list is read when the button is pressed: a page opened since Settings did is taken.
    await newTab(chrome, url('late'))
    expect(await waitFor(async () => (await titles(chrome)).includes('page late'))).toBe(true)
    // Pressed again until the list takes the page: on a slow runner the first press can read the
    // open pages before the new tab has reported its address.
    expect(await waitFor(async () => {
      await settings.evaluate((selector) => { document.querySelector<HTMLButtonElement>(selector)?.click() }, use)
      await delay(300)
      return await settings.evaluate(() => document.querySelectorAll('.page-list-item').length === 1)
    })).toBe(true)
    expect(await items(settings)).toEqual([url('late')])
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('offers the last session back after a crash, and Restore reopens its windows while the new tab page stays', async () => {
  const session = sessionText([
    { bounds: sized(60, 60), active: 0, tabs: [tabOf('a'), tabOf('b')] },
    { bounds: { x: 160, y: 120, width: 900, height: 640 }, active: 0, tabs: [tabOf('c')] }
  ], false)
  const { app, chrome } = await launchShell({ seedProfile: seed({ session }) })
  try {
    await waitTitles(chrome, ['New Tab'])
    expect(await waitFor(async () => await popoverShown(app, 'overlay=restore'))).toBe(true)
    expect(await waitFor(() => app.windows().some((w) => w.url().includes('overlay=restore')))).toBe(true)
    const bar = app.windows().find((w) => w.url().includes('overlay=restore')) as Page
    await bar.waitForSelector('.restorebar')
    expect(await bar.textContent('.restore-text')).toBe('Orivon didn\'t shut down correctly.')
    expect(await bar.getAttribute('.btn.icon', 'aria-label')).toBe('Dismiss')
    await shoot(bar, 'restore-bar')

    await bar.click('.btn.primary')
    expect(await waitFor(() => chromePages(app).length === 3)).toBe(true)
    await waitTitles(await windowShowing(app, 'page a'), ['page a', 'page b'])
    await waitTitles(await windowShowing(app, 'page c'), ['page c'])
    await waitTitles(chrome, ['New Tab'])
    expect(await waitFor(async () => !(await popoverShown(app, 'overlay=restore')))).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('leaves the session on the closed stack when the bar is dismissed, and offers nothing after a clean end or with the continue choice', async () => {
  const crashed = sessionText([{ active: 0, tabs: [tabOf('a')] }], false)
  const dismissed = await launchShell({ seedProfile: seed({ session: crashed }) })
  try {
    expect(await waitFor(async () => await popoverShown(dismissed.app, 'overlay=restore'))).toBe(true)
    expect(await waitFor(() => dismissed.app.windows().some((w) => w.url().includes('overlay=restore')))).toBe(true)
    const bar = dismissed.app.windows().find((w) => w.url().includes('overlay=restore')) as Page
    await bar.click('.btn.icon')
    expect(await waitFor(async () => !(await popoverShown(dismissed.app, 'overlay=restore')))).toBe(true)
    expect(await windowCount(dismissed.app)).toBe(1)
    await command(dismissed.chrome, 'tab.reopen')
    expect(await waitFor(() => chromePages(dismissed.app).length === 2)).toBe(true)
  } finally {
    await closeElectron(dismissed.app)
  }
  for (const files of [
    { session: sessionText([{ active: 0, tabs: [tabOf('a')] }], true) },
    { session: crashed, settings: { 'startup.mode': 'continue' } }
  ]) {
    const quiet = await launchShell({ seedProfile: seed(files) })
    try {
      await delay(2500)
      expect(await popoverShown(quiet.app, 'overlay=restore')).toBe(false)
    } finally {
      await closeElectron(quiet.app)
    }
  }
}, TEST_TIMEOUT_MS * 3)

it('gives way to the find bar, which shares the top of the page, and leaves the windows on the closed stack', async () => {
  const session = sessionText([{ bounds: sized(60, 60), active: 0, tabs: [tabOf('a')] }], false)
  const { app, chrome } = await launchShell({ seedProfile: seed({ session }) })
  try {
    expect(await waitFor(async () => await popoverShown(app, 'overlay=restore'))).toBe(true)
    await command(chrome, 'find.open')
    expect(await waitFor(async () => await popoverShown(app, 'overlay=find'))).toBe(true)
    expect(await waitFor(async () => !(await popoverShown(app, 'overlay=restore')))).toBe(true)
    await command(chrome, 'tab.reopen')
    expect(await waitFor(() => chromePages(app).length === 2)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
