// A page whose process dies, and one that stops answering, in the running shell: the tab says so on the strip,
// the active tab gets a card with Reload and Close tab, a background tab gets the card only when the person
// goes to it, and every way back (Reload, the reload keys, a typed address, closing the tab) leaves no trace.
// Set ORIVON_UI_SHOTS_DIR to also write screenshots in both colour schemes.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from './launch-electron.mjs'
import { clickAddressBarRetrying, pressKey } from './e2e-helpers.js'
import { html, launchShell, QA_TEST_TIMEOUT_MS, startServer, visit } from './qa-helpers.js'
import type { FixtureServer } from './qa-helpers.js'
import { delay, popoverShown, waitFor, waitForTab } from './smoke-helpers.mjs'

const SHOTS_DIR = process.env.ORIVON_UI_SHOTS_DIR

let server: FixtureServer
const loads = new Map<string, number>()

beforeAll(async () => {
  server = await startServer((request, response) => {
    const path = request.url ?? '/'
    loads.set(path, (loads.get(path) ?? 0) + 1)
    if (path === '/hang') {
      html(response, '<!doctype html><title>hang</title><body style="font:16px sans-serif"><button id="go" onclick="while (true) {}">Hang</button></body>')
      return
    }
    const title = path === '/' ? 'sad fixture' : path.slice(1)
    html(response, `<!doctype html><title>${title}</title><body style="font:16px sans-serif"><h1>${title}</h1><p>load ${String(loads.get(path))}</p></body>`)
  })
})

afterAll(async () => {
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type App = ElectronApplication

/** The newest card: a closed card's page stays listed, so the first match may be a dead one. */
const cardPage = (app: App): Page | undefined => app.windows().filter((w) => w.url().includes('overlay=sad-tab') && !w.isClosed()).at(-1)
const cardShown = async (app: App): Promise<boolean> => await popoverShown(app, 'overlay=sad-tab')
const here = (path = '/'): string => `${server.origin}${path}`

/** Ends a page's renderer the way a crash does. The call is deferred so the evaluate itself returns. */
async function crash (app: App, url: string): Promise<void> {
  await app.evaluate(({ webContents }, target) => {
    const wc = webContents.getAllWebContents().find((candidate) => candidate.getURL() === target)
    if (wc === undefined) throw new Error(`no webContents at ${target}`)
    setTimeout(() => { wc.forcefullyCrashRenderer() }, 0)
  }, url)
}

interface StripTab { id: string, title: string, active: boolean, crashed: boolean, tooltip: string, label: string, warning: boolean }

const strip = async (chrome: Page): Promise<StripTab[]> => await chrome.evaluate(() =>
  Array.from(document.querySelectorAll<HTMLElement>('.tab')).map((el) => ({
    id: el.dataset['id'] ?? '',
    title: el.querySelector('.title')?.textContent ?? '',
    active: el.classList.contains('active'),
    crashed: el.classList.contains('crashed'),
    tooltip: el.title,
    label: el.getAttribute('aria-label') ?? '',
    warning: el.querySelector('.fav svg') !== null
  })))

const tabTitled = async (chrome: Page, title: string): Promise<StripTab> => {
  const found = (await strip(chrome)).find((tab) => tab.title === title)
  expect(found, title).toBeDefined()
  return found as StripTab
}

async function waitCrashedMark (chrome: Page, title: string, crashed: boolean): Promise<void> {
  let last: StripTab[] = []
  const ok = await waitFor(async () => { last = await strip(chrome); return last.find((tab) => tab.title === title)?.crashed === crashed })
  expect({ ok, last }).toEqual({ ok: true, last })
}

async function waitCard (app: App, shown: boolean): Promise<Page | undefined> {
  expect(await waitFor(async () => await cardShown(app) === shown)).toBe(true)
  if (!shown) return undefined
  expect(await waitFor(() => cardPage(app) !== undefined)).toBe(true)
  const card = cardPage(app) as Page
  await card.waitForSelector('.sad .btn')
  return card
}

const activeFocus = async (card: Page): Promise<string> => await card.evaluate(() => document.activeElement?.textContent ?? '')

async function setScheme (app: App, scheme: 'light' | 'dark'): Promise<void> {
  await app.evaluate(({ nativeTheme }, source) => { nativeTheme.themeSource = source }, scheme)
  await delay(400)
}

async function shoot (name: string): Promise<void> {
  if (SHOTS_DIR === undefined) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  execFileSync('import', ['-window', 'root', join(SHOTS_DIR, `${name}.png`)])
}

async function resize (app: App, width: number, height: number): Promise<void> {
  await app.evaluate(({ BaseWindow }, [w, h]) => { BaseWindow.getAllWindows()[0]?.setSize(w as number, h as number) }, [width, height] as const)
  await delay(500)
}

it('marks a crashed tab, shows the card with Reload focused, and stays until told', async () => {
  const { app, chrome } = await launchShell()
  try {
    await visit(app, chrome, here())
    expect(await cardShown(app)).toBe(false)

    await crash(app, here())
    const card = await waitCard(app, true) as Page
    await waitCrashedMark(chrome, 'sad fixture', true)

    const tab = await tabTitled(chrome, 'sad fixture')
    expect(tab.warning).toBe(true)
    expect(tab.tooltip.split('\n').at(-1)).toBe('This tab crashed')
    expect(tab.label).toBe('sad fixture, crashed')

    expect(await card.locator('.sheet-title').textContent()).toBe('This page stopped working')
    expect(await card.locator('.sad-body').textContent()).toBe('Something went wrong while showing this page. Reloading usually fixes it.')
    expect(await card.locator('.sad-address').getAttribute('title')).toBe(here())
    expect(await card.locator('.sad .btn').allTextContents()).toEqual(['Close tab', 'Reload'])
    expect(await waitFor(async () => await activeFocus(card) === 'Reload')).toBe(true)
    expect(await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((wc) => wc.getURL().includes('overlay=sad-tab'))?.isFocused() === true)).toBe(true)

    // Nothing about the crash clears by itself: the flag and the card are still there a moment later.
    await delay(800)
    expect(await cardShown(app)).toBe(true)
    expect((await tabTitled(chrome, 'sad fixture')).crashed).toBe(true)

    // Escape has nowhere to go back to.
    await card.keyboard.press('Escape')
    await delay(400)
    expect(await cardShown(app)).toBe(true)

    // Tab moves between the two buttons.
    await card.keyboard.press('Shift+Tab')
    expect(await activeFocus(card)).toBe('Close tab')
    await card.keyboard.press('Tab')
    expect(await activeFocus(card)).toBe('Reload')

    await shoot('strip-and-card-1280-light')
    try { await card.keyboard.press('Enter') } catch (error) {
      const pages = app.windows().filter((w) => w.url().includes('overlay=sad-tab')).map((w) => w.isClosed())
      throw new Error(`DEBUG ${String(error)} pages=${JSON.stringify(pages)} shown=${String(await cardShown(app))} out=${mainOutput(app).slice(-1500)}`)
    }
    await waitCard(app, false)
    await waitCrashedMark(chrome, 'sad fixture', false)
    expect(await waitFor(() => loads.get('/') === 2)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('crashes again after a reload, and the reload keys and a typed address all bring it back', async () => {
  const { app, chrome } = await launchShell()
  loads.clear()
  try {
    await visit(app, chrome, here())
    await crash(app, here())
    await waitCard(app, true)
    await pressKey(app, 'overlay=sad-tab', 'F5')
    await waitCard(app, false)
    await waitCrashedMark(chrome, 'sad fixture', false)
    expect(await waitFor(() => loads.get('/') === 2)).toBe(true)

    await crash(app, here())
    await waitCard(app, true)
    await waitCrashedMark(chrome, 'sad fixture', true)
    await pressKey(app, 'overlay=sad-tab', 'R', ['control'])
    await waitCard(app, false)
    expect(await waitFor(() => loads.get('/') === 3)).toBe(true)

    await crash(app, here())
    await waitCard(app, true)
    await clickAddressBarRetrying(chrome, here('/other'))
    expect((await waitForTab(chrome, { address: here('/other') })).ok).toBe(true)
    await waitCard(app, false)
    await waitCrashedMark(chrome, 'other', false)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('shows only the strip mark for a tab that crashes in the background, and the card when it is activated', async () => {
  const { app, chrome } = await launchShell()
  try {
    await visit(app, chrome, here('/one'))
    await chrome.evaluate((url) => { (window as unknown as { orivonShell: { newTab: (u: string) => void } }).orivonShell.newTab(url) }, here('/two'))
    expect((await waitForTab(chrome, { address: here('/two') })).ok).toBe(true)

    await crash(app, here('/one'))
    await waitCrashedMark(chrome, 'one', true)
    await delay(600)
    expect(await cardShown(app)).toBe(false)
    expect((await tabTitled(chrome, 'two')).crashed).toBe(false)

    await chrome.locator('.tab', { hasText: 'one' }).click()
    const card = await waitCard(app, true) as Page
    expect(await card.locator('.sad-address').getAttribute('title')).toBe(here('/one'))

    await chrome.locator('.tab', { hasText: 'two' }).click()
    await waitCard(app, false)
    await chrome.locator('.tab', { hasText: 'one' }).click()
    await waitCard(app, true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('closes the tab from the card, and reopening brings back one entry, not two', async () => {
  const { app, chrome } = await launchShell()
  try {
    await visit(app, chrome, here('/one'))
    await chrome.evaluate((url) => { (window as unknown as { orivonShell: { newTab: (u: string) => void } }).orivonShell.newTab(url) }, here('/two'))
    expect((await waitForTab(chrome, { address: here('/two') })).ok).toBe(true)
    await chrome.locator('.tab', { hasText: 'one' }).click()
    await crash(app, here('/one'))
    const card = await waitCard(app, true) as Page

    await card.getByRole('button', { name: 'Close tab' }).click()
    await waitCard(app, false)
    expect(await waitFor(async () => (await strip(chrome)).every((tab) => tab.title !== 'one'))).toBe(true)
    const before = (await strip(chrome)).length

    await pressKey(app, here('/two'), 'T', ['control', 'shift'])
    expect(await waitFor(async () => (await strip(chrome)).some((tab) => tab.title === 'one'))).toBe(true)
    expect((await strip(chrome)).length).toBe(before + 1)
    expect(await waitFor(async () => await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().some((wc) => wc.getURL() === url && !wc.isLoading()), here('/one')))).toBe(true)
    await pressKey(app, here('/one'), 'T', ['control', 'shift'])
    await delay(800)
    expect((await strip(chrome)).filter((tab) => tab.title === 'one')).toHaveLength(1)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('draws the strip and the card in light and dark, at 1280 and 700 wide', async () => {
  const { app, chrome } = await launchShell()
  try {
    await visit(app, chrome, here())
    await chrome.evaluate((url) => { (window as unknown as { orivonShell: { newTab: (u: string) => void } }).orivonShell.newTab(url) }, here('/other'))
    expect((await waitForTab(chrome, { address: here('/other') })).ok).toBe(true)
    await chrome.locator('.tab', { hasText: 'sad fixture' }).click()
    for (const scheme of ['light', 'dark'] as const) {
      await setScheme(app, scheme)
      for (const width of [1280, 700]) {
        await resize(app, width, 800)
        await crash(app, here())
        const card = await waitCard(app, true) as Page
        await delay(300)
        await shoot(`card-${String(width)}-${scheme}`)
        if (width === 1280) await card.screenshot({ path: SHOTS_DIR === undefined ? '/dev/null' : join(SHOTS_DIR, `card-only-${scheme}.png`) })
        await card.keyboard.press('Enter')
        await waitCard(app, false)
        await waitCrashedMark(chrome, 'sad fixture', false)
      }
    }
    await setScheme(app, 'light')
    await resize(app, 1280, 800)
    await crash(app, here())
    await waitCard(app, true)
    await chrome.locator('.tab', { hasText: 'other' }).click()
    await waitCard(app, false)
    await shoot('strip-background-crash-1280-light')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS * 2)
