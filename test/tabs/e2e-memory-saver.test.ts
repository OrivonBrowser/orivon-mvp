// Sleeping tabs in the running shell: a tab put to sleep gives its page back and keeps its place in the strip, the
// session file and its history; it wakes where it was when it is opened; the idle pass sleeps exactly the tab that has
// been idle; a tab that is playing, pinned, typed into or on a kept site stays awake and says why. Screenshots of each
// state go to the directory named by ORIVON_MEMORY_SAVER_SHOTS when it is set. No test waits for real time: the idle
// pass runs through the test seam with the ages it is given.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { delay, findChrome, findViewShowing, HERMETIC_RESOLVER, popoverShown, tabIds, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

let server: Server
let origin = ''
const SHOTS = process.env['ORIVON_MEMORY_SAVER_SHOTS']

const TONE_PAGE = `<!doctype html><title>Radio</title><p>tone</p><script>
window.start = async () => {
  const ctx = new AudioContext()
  const osc = ctx.createOscillator()
  osc.frequency.value = 440
  osc.connect(ctx.destination)
  await ctx.resume()
  osc.start()
  window.__ctx = ctx
  return ctx.state
}
</script>`

// 200 MB held by the page, so what sleeping gives back is far above what the other processes move by.
const TALL_PAGE = `<!doctype html><title>Tall page</title><body style="margin:0"><div style="height:6000px;background:linear-gradient(#cde,#345)">tall</div><script>
window.__held = new Uint8Array(200 * 1024 * 1024).fill(7)
</script>`

const FORM_PAGE = '<!doctype html><title>Form page</title><form><input id="f" type="text"><textarea id="t"></textarea></form>'

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html')
    const path = request.url ?? ''
    if (path === '/tone') response.end(TONE_PAGE)
    else if (path === '/tall') response.end(TALL_PAGE)
    else if (path === '/form') response.end(FORM_PAGE)
    else response.end(`<!doctype html><title>Plain ${path.slice(3)}</title><p>${path}</p>`)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  if (SHOTS !== undefined) mkdirSync(SHOTS, { recursive: true })
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 120_000
const MIN = 60_000

const seed = (values: Record<string, unknown>) => async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values }))
}

async function launched (values: Record<string, unknown> = {}): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], seedProfile: seed(values) })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  // A driven browser counts every page as captured; the capture rule is checked in the unit tests.
  await app.evaluate(() => { (globalThis as unknown as { __orivonSleepIgnoreCapture: boolean }).__orivonSleepIgnoreCapture = true })
  return { app, chrome: findChrome(app) }
}

async function visit (chrome: Page, path: string): Promise<void> {
  await clickAddressBarRetrying(chrome, `${origin}${path}`)
  expect((await waitForTab(chrome, { address: `${origin}${path}` })).ok).toBe(true)
}

/** A new tab showing `path`; returns its id. */
async function openTab (chrome: Page, path: string): Promise<string> {
  await chrome.click('#new-tab')
  await visit(chrome, path)
  return (await activeId(chrome))
}

const activeId = async (chrome: Page): Promise<string> =>
  await chrome.evaluate(() => document.querySelector<HTMLElement>('.tab.active')?.dataset['id'] ?? '')

const runCommand = async (chrome: Page, id: string): Promise<void> => {
  await chrome.evaluate((command) => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand(command) }, id)
}

const tabEl = (chrome: Page, id: string) => chrome.locator(`.tab[data-id="${id}"]`)
const isSleeping = async (chrome: Page, id: string): Promise<boolean> => (await tabEl(chrome, id).getAttribute('class'))?.split(' ').includes('sleeping') === true

async function sleepNow (app: ElectronApplication, ago: Record<string, number>): Promise<string[]> {
  return await app.evaluate(async (_electron, stamps) => await (globalThis as unknown as { __orivonSweepNow: (ago: Record<string, number>) => Promise<string[]> }).__orivonSweepNow(stamps), ago)
}

interface Metrics { total: number, tabs: number, rows: string[] }
async function metrics (app: ElectronApplication): Promise<Metrics> {
  const all = await app.evaluate(({ app: electron }) => electron.getAppMetrics().map((m) => ({ type: m.type, pid: m.pid, kb: m.memory.workingSetSize })))
  const renderers = all.filter((m) => m.type === 'Tab')
  return { total: renderers.reduce((sum, m) => sum + m.kb, 0), tabs: renderers.length, rows: renderers.map((m) => `${String(m.pid)}:${String(Math.round(m.kb / 1024))}MB`) }
}

const toastPage = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().includes('overlay=toast'))
async function toastText (app: ElectronApplication): Promise<string | null> {
  if (!(await popoverShown(app, 'overlay=toast'))) return null
  const page = toastPage(app)
  if (page === undefined) return null
  try { return (await page.locator('.toast').innerText({ timeout: 500 })).replace(/\s+/g, ' ').trim() } catch { return null }
}
const waitForToast = async (app: ElectronApplication, text: string): Promise<boolean> => await waitFor(async () => (await toastText(app))?.startsWith(text) === true)

async function themed (page: Page, name: string, clip?: { x: number, y: number, width: number, height: number }): Promise<void> {
  if (SHOTS === undefined) return
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await waitFor(async () => await page.evaluate((t) => matchMedia('(prefers-color-scheme: dark)').matches === (t === 'dark'), theme))
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}.png`), ...(clip === undefined ? {} : { clip }) })
  }
  await page.emulateMedia({ colorScheme: null })
}
const stripShot = async (chrome: Page, name: string): Promise<void> => {
  await chrome.mouse.move(700, 60)
  await themed(chrome, name, { x: 0, y: 0, width: 1280, height: 76 })
}

it('puts a tab to sleep and wakes it where it was, and the idle pass sleeps exactly the tab that is idle', async () => {
  const { app, chrome } = await launched({ 'performance.sleepAfter': '15m' })
  let dir = ''
  try {
    const one = await openTab(chrome, '/p/one')
    const two = await openTab(chrome, '/p/two')
    // The tab to sleep has a page behind it and a long page in front, with scroll.
    await chrome.click('#new-tab')
    await visit(chrome, '/p/zero')
    await visit(chrome, '/tall')
    const tall = await activeId(chrome)
    const tallView = findViewShowing(app, chrome, `${origin}/tall`) as Page
    await tallView.evaluate(() => { window.scrollTo(0, 1500) })
    // A page's scroll reaches its history entry on a timer of Chromium's: sleeping happens after minutes in real use.
    await delay(2500)
    const before = await metrics(app)

    // From More tools, as a person would: the tab in front hands the window to the one beside it, then sleeps.
    await chrome.click('#menu')
    expect(await waitFor(async () => await popoverShown(app, 'overlay=menu'))).toBe(true)
    expect(await waitFor(() => app.windows().some((w) => w.url().includes('overlay=menu')))).toBe(true)
    const menu = app.windows().find((w) => w.url().includes('overlay=menu')) as Page
    await menu.waitForSelector('.menu-row')
    await menu.locator('.menu-row', { hasText: 'More tools' }).click()
    await menu.getByRole('menuitem', { name: /^Put tab to sleep/ }).click()

    const slept = await waitFor(async () => await isSleeping(chrome, tall))
    expect(slept).toBe(true)
    expect(await activeId(chrome)).toBe(two)
    // The strip still shows what the page was: its title, its address in the tooltip, and the state in the name.
    expect(await tabEl(chrome, tall).locator('.title').textContent()).toBe('Tall page')
    expect(await tabEl(chrome, tall).getAttribute('title')).toBe(`Tall page\n127.0.0.1:${new URL(origin).port}, sleeping`)
    expect(await tabEl(chrome, tall).getAttribute('aria-label')).toBe('Tall page, sleeping')
    expect(await waitFor(async () => (await metrics(app)).total < before.total - 100 * 1024)).toBe(true)
    const after = await metrics(app)
    console.error(`[memory-saver] renderers before ${String(before.tabs)} (${String(Math.round(before.total / 1024))} MB: ${before.rows.join(' ')}), after ${String(after.tabs)} (${String(Math.round(after.total / 1024))} MB: ${after.rows.join(' ')})`)
    expect(after.tabs).toBeLessThanOrEqual(before.tabs)
    await stripShot(chrome, 'strip-sleeping')

    // Opening it loads it again, back where it was, with the page behind it to go back to.
    await tabEl(chrome, tall).click()
    expect(await waitFor(async () => (await activeId(chrome)) === tall && !(await isSleeping(chrome, tall)))).toBe(true)
    expect(await waitFor(() => findViewShowing(app, chrome, `${origin}/tall`) !== undefined)).toBe(true)
    const woken = findViewShowing(app, chrome, `${origin}/tall`) as Page
    const scrolled = await waitFor(async () => (await woken.evaluate(() => window.scrollY)) > 1000)
    console.error(`[memory-saver] scrollY after waking: ${String(await woken.evaluate(() => window.scrollY))}`)
    expect(scrolled).toBe(true)
    expect(await chrome.locator('#back').isEnabled()).toBe(true)
    await chrome.click('#back')
    expect((await waitForTab(chrome, { address: `${origin}/p/zero` })).ok).toBe(true)

    // The idle pass: two background tabs, one idle for 16 minutes and one for 14, with a 15 minute wait.
    expect(await sleepNow(app, { [one]: 16 * MIN, [two]: 14 * MIN })).toEqual([one])
    expect(await waitFor(async () => await isSleeping(chrome, one))).toBe(true)
    expect(await isSleeping(chrome, two)).toBe(false)
    expect(await isSleeping(chrome, tall)).toBe(false)
    await stripShot(chrome, 'strip-idle-sleeping')

    // What the session file keeps of a sleeping tab: its address, and nothing of the page.
    dir = await app.evaluate(({ app: electron }) => electron.getPath('userData'))
    expect(await tabIds(chrome)).toContain(one)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app, { keepProfile: true })
  }
  try {
    const written = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8')) as { windows: Array<{ tabs: Array<{ url: string, title: string }> }> }
    const saved = written.windows[0]?.tabs ?? []
    expect(saved.map((tab) => tab.url)).toContain(`${origin}/p/one`)
    expect(saved.find((tab) => tab.url === `${origin}/p/one`)?.title).toBe('Plain one')
    expect(JSON.stringify(written)).not.toContain('pageState')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, TEST_TIMEOUT_MS)

it('keeps a tab awake that plays sound, is pinned, holds typed input or is on a kept site, and says why', async () => {
  const { app, chrome } = await launched({ 'performance.keepAwake': '127.0.0.1' })
  try {
    await openTab(chrome, '/p/other')
    const tone = await openTab(chrome, '/tone')
    const toneView = findViewShowing(app, chrome, `${origin}/tone`) as Page
    await toneView.evaluate(async () => await (window as unknown as { start: () => Promise<string> }).start())
    expect(await waitFor(async () => await app.evaluate(({ webContents }) => webContents.getAllWebContents().some((wc) => wc.getURL().endsWith('/tone') && wc.isCurrentlyAudible())), 15_000)).toBe(true)

    await runCommand(chrome, 'tab.sleep')
    expect(await waitForToast(app, 'This tab is playing sound, so it stays awake.')).toBe(true)
    expect(await activeId(chrome)).toBe(tone)
    expect(await isSleeping(chrome, tone)).toBe(false)
    if (SHOTS !== undefined) await themed(toastPage(app) as Page, 'toast-sound')

    const pinned = await openTab(chrome, '/p/pinned')
    await runCommand(chrome, 'tab.pin')
    await delay(300)
    await runCommand(chrome, 'tab.sleep')
    expect(await waitForToast(app, 'Pinned tabs stay awake.')).toBe(true)
    expect(await isSleeping(chrome, pinned)).toBe(false)

    const form = await openTab(chrome, '/form')
    if (process.platform === 'darwin') {
      // Playwright sometimes never attaches the page of a tab opened later on macOS (test/README.md, Known risk), so the
      // text goes in from the main process, as typing does: focus the field, then one char event per letter.
      await app.evaluate(async ({ webContents }, [url, text]) => {
        const wc = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)
        if (wc === undefined) throw new Error(`no webContents at ${url as string}`)
        wc.focus()
        await wc.executeJavaScript('document.getElementById("f").focus()')
        for (const character of text as string) wc.sendInputEvent({ type: 'char', keyCode: character })
        // The events reach the page asynchronously: leave the field only once it holds the text.
        for (let tries = 0; tries < 100 && await wc.executeJavaScript('document.getElementById("f").value') !== text; tries += 1) await new Promise((resolve) => setTimeout(resolve, 50))
        await wc.executeJavaScript('document.activeElement.blur()')
      }, [`${origin}/form`, 'half a message'] as const)
    } else {
      const formView = findViewShowing(app, chrome, `${origin}/form`) as Page
      await formView.fill('#f', 'half a message')
      await formView.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur() })
    }
    await runCommand(chrome, 'tab.sleep')
    const said = await waitForToast(app, 'This tab has unsaved changes, so it stays awake.')
    expect(said).toBe(true)
    expect(await isSleeping(chrome, form)).toBe(false)
    expect(await activeId(chrome)).toBe(form)
    if (SHOTS !== undefined) await themed(toastPage(app) as Page, 'toast-unsaved')

    // A site on the list, and its idle tab: the pass leaves it, and the command says so. Loading outranks a kept
    // site among the reasons, and the address shows before the load stops, so the load is waited out first.
    const kept = await openTab(chrome, '/p/kept')
    expect(await waitFor(async () => await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().some((wc) => wc.getURL() === url && !wc.isLoading()), `${origin}/p/kept`))).toBe(true)
    expect(await sleepNow(app, { [kept]: 60 * MIN, [tone]: 60 * MIN, [pinned]: 60 * MIN, [form]: 60 * MIN })).toEqual([])
    await runCommand(chrome, 'tab.sleep')
    expect(await waitForToast(app, 'This site is set to stay awake.')).toBe(true)
    expect(await isSleeping(chrome, kept)).toBe(false)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('shows the Performance settings, with the list empty and filled, on and off', async () => {
  const { app, chrome } = await launched({ 'performance.keepAwake': 'mail.example\nchat.example' })
  try {
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (p: string, path?: string) => void } }).orivonShell.openInternal('settings', '/performance') })
    expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
    const page = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
    await page.waitForSelector('.layout')
    await page.locator('#row-memory-saver').waitFor()
    expect(await page.locator('#row-sleep-after').count()).toBe(1)
    expect(await page.locator('.host-list-item .item-title').allTextContents()).toEqual(['mail.example', 'chat.example'])
    await themed(page, 'settings-performance-on')

    await page.locator('#row-memory-saver .switch').click()
    // A switch keeps the keyboard until the person moves on, and the page is drawn again then.
    await page.mouse.click(1200, 690)
    const hidden = await waitFor(async () => (await page.locator('#row-sleep-after').count()) === 0)
    expect(hidden).toBe(true)
    await themed(page, 'settings-performance-off')

    // With both savers off nothing sleeps, so the list of sites that never do is not shown; with the memory saver on again it is.
    expect(await page.locator('#row-keep-awake').count()).toBe(0)
    await page.locator('#row-memory-saver .switch').click()
    await page.mouse.click(1200, 690)
    expect(await waitFor(async () => (await page.locator('#row-keep-awake').count()) === 1)).toBe(true)

    // The list, emptied by its own remove buttons.
    for (let left = 2; left > 0; left--) await page.locator('.host-list-remove').first().click()
    expect(await waitFor(async () => (await page.locator('.host-list .empty-state').count()) === 1)).toBe(true)
    expect(await page.locator('.host-list .empty-state').innerText()).toContain('Sites you add here never go to sleep.')
    await themed(page, 'settings-performance-empty')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('does not add a renderer for each sleeping tab', async () => {
  const { app, chrome } = await launched({ 'performance.sleepAfter': '15m' })
  try {
    const ids: string[] = []
    for (const name of ['a', 'b', 'c', 'd']) ids.push(await openTab(chrome, `/p/${name}`))
    await openTab(chrome, '/p/front')
    await delay(1500)
    const before = await metrics(app)
    const slept = await sleepNow(app, Object.fromEntries(ids.map((id) => [id, 20 * MIN])))
    expect(slept.sort()).toEqual([...ids].sort())
    await delay(5000)
    const after = await metrics(app)
    console.error(`[memory-saver] four tabs asleep: renderers ${String(before.tabs)} -> ${String(after.tabs)}, ${String(Math.round(before.total / 1024))} -> ${String(Math.round(after.total / 1024))} MB (${after.rows.join(' ')})`)
    expect(after.tabs).toBeLessThanOrEqual(before.tabs)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('offers Put Tab to Sleep in the menu of a tab behind the one in front, and not for the tab in front', async () => {
  const { app, chrome } = await launched()
  try {
    await app.evaluate(({ Menu }) => { (Menu.prototype as unknown as { popup: () => void }).popup = function (this: unknown) { (globalThis as unknown as { __menu: unknown }).__menu = this } })
    const enabled = async (): Promise<boolean | undefined> => await app.evaluate(() => ((globalThis as unknown as { __menu?: { items: Array<{ label: string, enabled: boolean }> } }).__menu?.items ?? []).find((item) => item.label === 'Put Tab to Sleep')?.enabled)
    const choose = async (): Promise<void> => { await app.evaluate(() => { ((globalThis as unknown as { __menu: { items: Array<{ label: string, click: () => void }> } }).__menu.items.find((item) => item.label === 'Put Tab to Sleep'))?.click() }) }
    const behind = await openTab(chrome, '/p/behind')
    const front = await openTab(chrome, '/p/front')

    await chrome.click(`.tab[data-id="${front}"]`, { button: 'right' })
    expect(await waitFor(async () => (await enabled()) !== undefined)).toBe(true)
    expect(await enabled()).toBe(false)

    await chrome.click(`.tab[data-id="${behind}"]`, { button: 'right' })
    expect(await waitFor(async () => (await enabled()) === true)).toBe(true)
    await choose()
    expect(await waitFor(async () => await isSleeping(chrome, behind))).toBe(true)
    // Choosing it did not move the person off the tab they were in.
    expect(await activeId(chrome)).toBe(front)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
