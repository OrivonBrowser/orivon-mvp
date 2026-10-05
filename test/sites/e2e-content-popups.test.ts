// Pop-ups a page opens by itself are blocked and listed under a chip in the address bar; the person's own click or
// key press opens what they asked for, once per input; the bubble under the chip opens one blocked address on
// purpose or allows the site for good. Real mouse clicks drive the pages (they reach the browser process as input);
// a script's synthetic click and a script's own window.open do not count. Set ORIVON_UI_SHOTS_DIR to also write
// screenshots in both colour schemes.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from '../support/launch-electron.mjs'
import { html, launchShell, startServer, visit } from '../support/qa-helpers.js'
import type { FixtureServer } from '../support/qa-helpers.js'
import { delay, popoverShown, tabIds, waitFor } from '../support/smoke-helpers.mjs'

const SHOTS_DIR = process.env.ORIVON_UI_SHOTS_DIR
const E2E_TIMEOUT_MS = 240_000

const TARGET = (query: string): string => `<!doctype html><title>target ${query}</title><p>target</p>`
const PAGES: Record<string, string> = {
  '/one': `<!doctype html><title>one</title><script>window.open('/target?one')</script>`,
  '/load': `<!doctype html><title>load</title><script>window.open('/target?a'); setTimeout(() => window.open('/target?b'), 150)</script>`,
  '/start': `<!doctype html><title>start</title><body style="font:16px sans-serif"><a id="go" href="/one">go</a>`,
  '/click': `<!doctype html><title>click</title><body style="font:16px sans-serif">
<button id="open">open</button> <button id="five">five</button> <button id="fetch">fetch</button> <button id="key">key</button>
<a id="s" target="_blank" href="/target?synthetic">synthetic</a>
<script>
const on = (id, run) => document.getElementById(id).addEventListener('click', run)
on('open', () => { window.open('/target?click') })
on('five', () => { for (let i = 0; i < 5; i += 1) window.open('/target?five' + i) })
on('fetch', async () => { const t = performance.now(); await fetch('/slow'); window.__after = Math.round(performance.now() - t); window.open('/target?fetch') })
</script>`
}

let a: FixtureServer
let b: FixtureServer

async function serve (): Promise<FixtureServer> {
  return await startServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x')
    if (url.pathname === '/target') html(response, TARGET(url.search.slice(1)))
    else if (url.pathname === '/slow') setTimeout(() => { response.end('ok') }, 1500)
    else html(response, PAGES[url.pathname] ?? PAGES['/click'] ?? '')
  })
}

beforeAll(async () => {
  a = await serve()
  b = await serve()
})

afterAll(async () => {
  await a.close()
  await b.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type App = ElectronApplication

const bubblePage = (app: App): Page | undefined => app.windows().filter((w) => w.url().includes('overlay=popups-blocked') && !w.isClosed()).at(-1)
const bubbleShown = async (app: App): Promise<boolean> => await popoverShown(app, 'overlay=popups-blocked')

async function waitBubble (app: App): Promise<Page> {
  let found: Page | undefined
  const ok = await waitFor(async () => {
    if (!(await bubbleShown(app))) return false
    const candidate = bubblePage(app)
    if (candidate === undefined) return false
    try { await candidate.waitForSelector('.popups-bubble .btn-row', { timeout: 2_000 }); found = candidate; return true } catch { return false }
  }, 15_000)
  expect(ok).toBe(true)
  return found as Page
}

interface Chip { hidden: boolean, label: string, badge: string }
const chipOf = async (chrome: Page): Promise<Chip> => await chrome.evaluate(() => {
  const chip = document.querySelector<HTMLButtonElement>('#popups-chip')
  const badge = chip?.querySelector<HTMLElement>('.popups-count')
  return { hidden: chip === null || chip.hidden === true, label: chip?.getAttribute('aria-label') ?? '', badge: badge === null || badge === undefined || badge.hidden ? '' : badge.textContent ?? '' }
})
async function waitChip (chrome: Page, hidden: boolean, label?: string): Promise<Chip> {
  let last: Chip = { hidden: true, label: '', badge: '' }
  const ok = await waitFor(async () => { last = await chipOf(chrome); return last.hidden === hidden && (label === undefined || last.label === label) })
  expect({ ok, last }).toEqual({ ok: true, last })
  return last
}
const activeTab = async (chrome: Page): Promise<string> => await chrome.evaluate(() => document.querySelector<HTMLElement>('.tab.active')?.dataset['id'] ?? '')
/** The window a page opens comes to the front; what it was blocked from opening is listed on the page that tried. */
async function backToOpener (chrome: Page, id: string): Promise<void> {
  await chrome.click(`.tab[data-id="${id}"]`)
  expect(await waitFor(async () => (await activeTab(chrome)) === id)).toBe(true)
}
const tabCount = async (chrome: Page): Promise<number> => (await tabIds(chrome)).length
const waitTabs = async (chrome: Page, count: number): Promise<boolean> => await waitFor(async () => (await tabCount(chrome)) === count)

async function setScheme (app: App, pages: Page[], scheme: 'light' | 'dark'): Promise<void> {
  await app.evaluate(({ nativeTheme }, source) => { nativeTheme.themeSource = source }, scheme)
  for (const page of pages) await page.emulateMedia({ colorScheme: scheme })
  await delay(400)
}

async function shootBoth (app: App, chrome: Page, name: string, bubble: Page | null): Promise<void> {
  if (SHOTS_DIR === undefined) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await setScheme(app, bubble === null ? [chrome] : [chrome, bubble], scheme)
    await chrome.mouse.move(700, 60)
    await chrome.screenshot({ path: join(SHOTS_DIR, `${name}-chrome-${scheme}.png`), clip: { x: 0, y: 0, width: 1280, height: 100 } })
    if (bubble !== null) await bubble.screenshot({ path: join(SHOTS_DIR, `${name}-bubble-${scheme}.png`) })
    execFileSync('import', ['-window', 'root', join(SHOTS_DIR, `${name}-window-${scheme}.png`)])
  }
  await setScheme(app, bubble === null ? [chrome] : [chrome, bubble], 'light')
}

it('blocks what a page opens by itself, lists it under a chip, and opens one on purpose', async () => {
  const { app, chrome } = await launchShell()
  try {
    // A page that opens a window on load: no new tab, the chip says so.
    await visit(app, chrome, `${a.origin}/one`)
    await waitChip(chrome, false, 'Pop-ups blocked on this page')
    expect((await chipOf(chrome)).badge).toBe('')
    expect(await tabCount(chrome)).toBe(1)
    await shootBoth(app, chrome, 'chip-one', null)

    // Two attempts: the badge counts them.
    await visit(app, chrome, `${a.origin}/load`)
    await waitChip(chrome, false, 'Pop-ups blocked on this page: 2')
    expect((await chipOf(chrome)).badge).toBe('2')
    await delay(600)
    expect(await tabCount(chrome)).toBe(1)

    // The bubble lists both, newest first, with the whole address on hover.
    await chrome.click('#popups-chip')
    let bubble = await waitBubble(app)
    expect(await bubble.locator('.sheet-title').textContent()).toBe('Pop-ups blocked')
    expect(await bubble.locator('.origin').textContent()).toBe(a.origin)
    const host = new URL(a.origin).host
    expect(await bubble.locator('.listbox-item .item-title').allTextContents()).toEqual([`${host}/target?b`, `${host}/target?a`])
    expect(await bubble.locator('.listbox-item').first().getAttribute('title')).toBe(`${a.origin}/target?b`)
    expect(await bubble.locator('input[type=radio]:checked').getAttribute('value')).toBe('block')
    expect(await bubble.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('listbox')
    await shootBoth(app, chrome, 'bubble-two', bubble)

    // The keyboard moves through the list; Enter opens the selected address in a new tab.
    await bubble.keyboard.press('ArrowDown')
    expect(await bubble.locator('.listbox-item[aria-selected=true] .item-title').textContent()).toBe(`${new URL(a.origin).host}/target?a`)
    await bubble.keyboard.press('ArrowUp')
    await bubble.keyboard.press('ArrowDown')
    try { await bubble.keyboard.press('Enter') } catch (error) { if (!/closed|destroyed/.test(String(error))) throw error }
    expect(await waitTabs(chrome, 2)).toBe(true)
    expect(await waitFor(async () => !(await bubbleShown(app)))).toBe(true)
    expect(await waitFor(() => app.windows().some((w) => w.url() === `${a.origin}/target?a`))).toBe(true)

    // Escape closes without changing anything.
    await visit(app, chrome, `${a.origin}/load`)
    await waitChip(chrome, false, 'Pop-ups blocked on this page: 2')
    await chrome.click('#popups-chip')
    bubble = await waitBubble(app)
    await bubble.locator('input[value="allow"]').check()
    try { await bubble.keyboard.press('Escape') } catch (error) { if (!/closed|destroyed/.test(String(error))) throw error }
    expect(await waitFor(async () => !(await bubbleShown(app)))).toBe(true)
    await delay(500)
    expect(existsSync(join(await userData(app), 'site-settings.json'))).toBe(false)

    // Always allow, then the same page opens its windows as tabs.
    await chrome.click('#popups-chip')
    bubble = await waitBubble(app)
    expect(await bubble.locator('input[type=radio]:checked').getAttribute('value')).toBe('block')
    await bubble.locator('input[value="allow"]').check()
    await shootBoth(app, chrome, 'bubble-allow', bubble)
    await bubble.click('.btn.primary')
    expect(await waitFor(async () => !(await bubbleShown(app)))).toBe(true)
    const file = join(await userData(app), 'site-settings.json')
    expect(await waitFor(() => existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).sites?.[a.origin]?.popups === 'allow')).toBe(true)
    const before = await tabCount(chrome)
    await visit(app, chrome, `${a.origin}/load`)
    expect(await waitTabs(chrome, before + 2)).toBe(true)
    await waitChip(chrome, true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

async function userData (app: App): Promise<string> {
  return await app.evaluate(({ app: electron }) => electron.getPath('userData'))
}

it('lets the person\'s own click open a window, once per click, and ignores a script\'s clicks', async () => {
  const { app, chrome } = await launchShell()
  try {
    // A real click: the window opens, no chip.
    let view = await visit(app, chrome, `${b.origin}/click?visit=1`)
    let tabs = await tabCount(chrome)
    let opener = await activeTab(chrome)
    await view.click('#open')
    expect(await waitTabs(chrome, tabs + 1)).toBe(true)
    expect(await waitFor(() => app.windows().some((w) => w.url() === `${b.origin}/target?click`))).toBe(true)
    await backToOpener(chrome, opener)
    await waitChip(chrome, true)

    // A script's own click event and its own window.open: no input reached the browser, so no window opens.
    view = await visit(app, chrome, `${b.origin}/click?visit=2`)
    tabs = await tabCount(chrome)
    await view.evaluate(() => { document.getElementById('s')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await waitChip(chrome, false, 'Pop-ups blocked on this page')
    await view.evaluate(() => { window.open('/target?evaluate') })
    await waitChip(chrome, false, 'Pop-ups blocked on this page: 2')
    await delay(600)
    expect(await tabCount(chrome)).toBe(tabs)

    // Five windows from one click: one opens, four are blocked and counted.
    view = await visit(app, chrome, `${b.origin}/click?visit=3`)
    tabs = await tabCount(chrome)
    opener = await activeTab(chrome)
    await view.click('#five')
    expect(await waitTabs(chrome, tabs + 1)).toBe(true)
    await backToOpener(chrome, opener)
    await waitChip(chrome, false, 'Pop-ups blocked on this page: 4')
    await delay(600)
    expect(await tabCount(chrome)).toBe(tabs + 1)

    // A window opened after a slow network call the click started still counts as the person's.
    view = await visit(app, chrome, `${b.origin}/click?visit=4`)
    tabs = await tabCount(chrome)
    opener = await activeTab(chrome)
    await view.click('#fetch')
    expect(await waitTabs(chrome, tabs + 1)).toBe(true)
    expect(await waitFor(() => app.windows().some((w) => w.url() === `${b.origin}/target?fetch`))).toBe(true)
    await backToOpener(chrome, opener)
    await waitChip(chrome, true)

    // The key press opens one as well: focus the button and press Enter.
    view = await visit(app, chrome, `${b.origin}/click?visit=5`)
    tabs = await tabCount(chrome)
    await view.focus('#open')
    await view.keyboard.press('Enter')
    expect(await waitTabs(chrome, tabs + 1)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('does not let the click that led to a page pay for a pop-up that page opens as it loads', async () => {
  const { app, chrome } = await launchShell()
  try {
    const view = await visit(app, chrome, `${a.origin}/start`)
    // A real click on a link: the person's input belongs to the page they clicked on, not to the one that arrives.
    await view.click('#go')
    await waitChip(chrome, false, 'Pop-ups blocked on this page')
    await delay(600)
    expect(await tabCount(chrome)).toBe(1)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)
