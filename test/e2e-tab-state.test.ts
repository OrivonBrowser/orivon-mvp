// Pin, mute and the bulk closes in the running shell: a pinned tab leads the strip and has no close button, the
// commands close and copy tabs around it, a page's sound shows on its tab and can be switched off from there, and
// the tab's right-click menu lists what can be done to it. Screenshots of each state go to the directory named by
// ORIVON_TAB_STATE_SHOTS when it is set.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from './launch-electron.mjs'
import { clickAddressBarRetrying } from './e2e-helpers.js'
import { findChrome, HERMETIC_RESOLVER, tabIds, waitFor, waitForTab } from './smoke-helpers.mjs'

let server: Server
let origin = ''
const SHOTS = process.env['ORIVON_TAB_STATE_SHOTS']

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
window.stop = () => window.__ctx.close()
</script>`

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end(request.url === '/tone' ? TONE_PAGE : `<!doctype html><title>Page ${request.url ?? ''}</title><p>${request.url ?? ''}</p>`)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  if (SHOTS !== undefined) mkdirSync(SHOTS, { recursive: true })
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 90_000

async function launched (): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

/** Opens `paths` as tabs, one after the other; the dashboard tab the window starts with stays first. */
async function openTabs (chrome: Page, ...paths: string[]): Promise<string[]> {
  for (const path of paths) {
    await chrome.click('#new-tab')
    await clickAddressBarRetrying(chrome, `${origin}${path}`)
    expect((await waitForTab(chrome, { address: `${origin}${path}` })).ok).toBe(true)
  }
  return await tabIds(chrome)
}

const runCommand = async (chrome: Page, id: string): Promise<void> => {
  await chrome.evaluate((command) => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand(command) }, id)
}

const act = async (chrome: Page, name: string, payload: unknown): Promise<void> => {
  await chrome.evaluate(([n, p]) => { void (window as unknown as { orivonShell: { act: (n: string, p: unknown) => Promise<unknown> } }).orivonShell.act(n as string, p) }, [name, payload])
}

const order = async (chrome: Page): Promise<string[]> => (await tabIds(chrome)) as string[]
const pinnedIds = async (chrome: Page): Promise<string[]> => await chrome.evaluate(() => [...document.querySelectorAll<HTMLElement>('.tab.pinned')].map((el) => el.dataset['id'] ?? ''))
const activate = async (chrome: Page, id: string): Promise<void> => { await chrome.click(`.tab[data-id="${id}"]`) }

async function sameOrder (chrome: Page, expected: string[]): Promise<boolean> {
  return await waitFor(async () => (await order(chrome)).join() === expected.join())
}

async function shoot (chrome: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return
  for (const theme of ['light', 'dark'] as const) {
    // The chrome view's own media query, which is all its colours follow; the OS setting is not touched.
    await chrome.emulateMedia({ colorScheme: theme })
    await chrome.mouse.move(700, 60)
    await waitFor(async () => await chrome.evaluate((t) => matchMedia('(prefers-color-scheme: dark)').matches === (t === 'dark'), theme))
    await chrome.waitForTimeout(250)
    await chrome.screenshot({ path: join(SHOTS, `${name}-${theme}.png`), clip: { x: 0, y: 0, width: 1280, height: 76 } })
  }
  await chrome.emulateMedia({ colorScheme: null })
}

/** The webContents of the tab showing `path`, by address. */
const pageOf = (path: string): string => `${origin}${path}`

it('pins a tab to the front of the strip without a close button, and unpins it after the pinned ones', async () => {
  const { app, chrome } = await launched()
  try {
    const [first, a, b, c] = await openTabs(chrome, '/a', '/b', '/c') as [string, string, string, string]

    await runCommand(chrome, 'tab.pin') // /c is in front
    expect(await sameOrder(chrome, [c, first, a, b])).toBe(true)
    expect(await pinnedIds(chrome)).toEqual([c])
    expect(await chrome.locator(`.tab[data-id="${c}"] .close`).count()).toBe(0)
    expect(await chrome.locator(`.tab[data-id="${c}"]`).getAttribute('aria-label')).toBe('Page /c')
    // The one in front stays in front.
    expect(await chrome.locator(`.tab[data-id="${c}"]`).getAttribute('aria-selected')).toBe('true')

    await activate(chrome, b)
    await runCommand(chrome, 'tab.pin')
    expect(await sameOrder(chrome, [c, b, first, a])).toBe(true)

    await activate(chrome, c)
    await runCommand(chrome, 'tab.pin') // unpin: the first place after the pinned run
    expect(await sameOrder(chrome, [b, c, first, a])).toBe(true)
    expect(await pinnedIds(chrome)).toEqual([b])
    expect(await chrome.locator(`.tab[data-id="${c}"] .close`).count()).toBe(1)

    // A tab moved by a command stays on its side of the boundary.
    await runCommand(chrome, 'tab.moveLeft')
    await runCommand(chrome, 'tab.moveLeft')
    expect(await sameOrder(chrome, [b, c, first, a])).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('closes the others, or those to the right, but never a pinned tab, and copies a tab beside it', async () => {
  const { app, chrome } = await launched()
  try {
    const [first, a, b, c] = await openTabs(chrome, '/a', '/b', '/c') as [string, string, string, string]
    await activate(chrome, a)
    await runCommand(chrome, 'tab.pin')
    expect(await sameOrder(chrome, [a, first, b, c])).toBe(true)

    // To the right of the second tab: /b and /c go, the pinned tab and the ones before stay.
    await activate(chrome, first)
    await runCommand(chrome, 'tab.closeRight')
    expect(await sameOrder(chrome, [a, first])).toBe(true)

    // A copy lands right of its source, in front, unpinned, with the same address.
    const [, , d] = await openTabs(chrome, '/d') as [string, string, string]
    await activate(chrome, d)
    await activate(chrome, first)
    await runCommand(chrome, 'tab.duplicate') // the dashboard: no copy
    await chrome.waitForTimeout(500)
    expect(await order(chrome)).toEqual([a, first, d])
    await activate(chrome, d)
    await runCommand(chrome, 'tab.duplicate')
    expect(await waitFor(async () => (await order(chrome)).length === 4)).toBe(true)
    const ids = await order(chrome)
    expect(ids.slice(0, 3)).toEqual([a, first, d])
    const copy = ids[3] as string
    expect(await waitFor(async () => (await chrome.locator(`.tab[data-id="${copy}"]`).getAttribute('title'))?.startsWith('Page /d') === true)).toBe(true)
    expect(await chrome.locator(`.tab[data-id="${copy}"]`).getAttribute('aria-selected')).toBe('true')

    await activate(chrome, d)
    await runCommand(chrome, 'tab.closeOthers')
    expect(await sameOrder(chrome, [a, d])).toBe(true)
    expect(await pinnedIds(chrome)).toEqual([a])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('gives the copy of a tab the pages behind it', async () => {
  const { app, chrome } = await launched()
  try {
    await openTabs(chrome, '/one')
    await clickAddressBarRetrying(chrome, pageOf('/two'))
    expect((await waitForTab(chrome, { address: pageOf('/two') })).ok).toBe(true)
    await runCommand(chrome, 'tab.duplicate')
    expect(await waitFor(async () => (await order(chrome)).length === 3)).toBe(true)
    const copy = (await order(chrome))[2] as string
    await waitForTab(chrome, { address: pageOf('/two') })
    const canGoBack = await waitFor(async () => await app.evaluate(({ webContents }, url) => {
      const wcs = webContents.getAllWebContents().filter((w) => w.getURL() === url && !w.isLoading())
      // The original has a page behind it too: both must.
      return wcs.filter((w) => w.navigationHistory.canGoBack()).length === 2
    }, pageOf('/two')))
    expect(canGoBack, `copy ${copy} has no history`).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('shows a page\'s sound on its tab, mutes it from the badge and keeps it muted', async () => {
  const { app, chrome } = await launched()
  try {
    const [first, tone] = await openTabs(chrome, '/tone') as [string, string]
    // The tab shows the address until the page's own title arrives.
    const tooltip = async (): Promise<string | null> => await chrome.locator(`.tab[data-id="${tone}"]`).getAttribute('title')
    expect(await waitFor(async () => await tooltip() === `Radio\n${origin.slice('http://'.length)}`)).toBe(true)
    expect(await chrome.locator('.tab-audio').count()).toBe(0)

    // The tone needs a user gesture to start, as any page's does.
    const started = await app.evaluate(async ({ webContents }, url) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL() === url)
      return await wc?.executeJavaScript('window.start()', true)
    }, pageOf('/tone'))
    expect(started).toBe('running')
    expect(await waitFor(async () => await chrome.locator(`.tab[data-id="${tone}"] .tab-audio`).count() === 1)).toBe(true)
    expect(await chrome.locator(`.tab[data-id="${tone}"] .tab-audio`).getAttribute('aria-label')).toBe('Mute tab')
    expect(await chrome.locator(`.tab[data-id="${tone}"]`).getAttribute('title')).toContain('(playing audio)')
    await shoot(chrome, 'audible')

    // Mute through the main-process action the badge uses; the page goes quiet and the badge says so.
    await act(chrome, 'tab.mute', { id: tone })
    const muted = async (): Promise<boolean> => await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((w) => w.getURL() === url)?.isAudioMuted() === true, pageOf('/tone'))
    expect(await waitFor(muted)).toBe(true)
    expect(await waitFor(async () => await chrome.locator(`.tab[data-id="${tone}"] .tab-audio`).getAttribute('aria-label') === 'Unmute tab')).toBe(true)
    expect(await chrome.locator(`.tab[data-id="${tone}"]`).getAttribute('title')).toContain('(muted)')
    await shoot(chrome, 'muted')

    // It survives a navigation of the same tab, and a click on the badge undoes it.
    await activate(chrome, tone)
    await clickAddressBarRetrying(chrome, pageOf('/x'))
    expect((await waitForTab(chrome, { address: pageOf('/x') })).ok).toBe(true)
    expect(await waitFor(async () => await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((w) => w.getURL() === url)?.isAudioMuted() === true, pageOf('/x')))).toBe(true)
    expect(await chrome.locator(`.tab[data-id="${tone}"] .tab-audio`).count()).toBe(1)
    await chrome.locator(`.tab[data-id="${tone}"] .tab-audio`).click()
    expect(await waitFor(async () => await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((w) => w.getURL() === url)?.isAudioMuted() === false, pageOf('/x')))).toBe(true)
    // The click was on the badge, not the tab: the tab in front did not change, and it was not dragged.
    expect(await chrome.locator(`.tab[data-id="${tone}"]`).getAttribute('aria-selected')).toBe('true')
    expect(await order(chrome)).toEqual([first, tone])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('offers what can be done to a tab in its menu, and does it', async () => {
  const { app, chrome } = await launched()
  try {
    await app.evaluate(({ Menu }) => { (Menu.prototype as unknown as { popup: () => void }).popup = function (this: unknown) { (globalThis as unknown as { __menu: unknown }).__menu = this } })
    const [first, a, b] = await openTabs(chrome, '/a', '/b') as [string, string, string]
    const labels = async (): Promise<string[]> => await app.evaluate(() => ((globalThis as unknown as { __menu?: { items: Array<{ label: string, type: string }> } }).__menu?.items ?? []).filter((item) => item.type !== 'separator').map((item) => item.label))
    const enabled = async (label: string): Promise<boolean | undefined> => await app.evaluate((_, l) => ((globalThis as unknown as { __menu?: { items: Array<{ label: string, enabled: boolean }> } }).__menu?.items ?? []).find((item) => item.label === l)?.enabled, label)
    const choose = async (label: string): Promise<void> => { await app.evaluate((_, l) => { ((globalThis as unknown as { __menu: { items: Array<{ label: string, click: () => void }> } }).__menu.items.find((item) => item.label === l))?.click() }, label) }

    await chrome.click(`.tab[data-id="${a}"]`, { button: 'right' })
    expect(await waitFor(async () => (await labels()).length > 5)).toBe(true)
    expect(await labels()).toEqual(['New Tab to the Right', 'Reload', 'Duplicate', 'Pin Tab', 'Mute Tab', 'Split with', 'Move Tab to New Window', 'Close Tab', 'Close Other Tabs', 'Close Tabs to the Right', 'Reopen Closed Tab'])
    expect(await enabled('Duplicate')).toBe(true)

    await choose('Pin Tab')
    expect(await sameOrder(chrome, [a, first, b])).toBe(true)
    await chrome.click(`.tab[data-id="${a}"]`, { button: 'right' })
    expect(await waitFor(async () => (await labels()).includes('Unpin Tab'))).toBe(true)
    // A pinned tab has no one to split with, and nothing is pinned to its left to close.
    expect(await enabled('Split with')).toBe(false)
    await choose('Unpin Tab')
    expect(await waitFor(async () => (await pinnedIds(chrome)).length === 0)).toBe(true)

    await chrome.click(`.tab[data-id="${first}"]`, { button: 'right' })
    await waitFor(async () => (await labels()).includes('Mute Tab'))
    await choose('New Tab to the Right')
    expect(await waitFor(async () => (await order(chrome)).length === 4)).toBe(true)
    expect((await order(chrome))[1]).not.toBe(a)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('draws pinned, playing and muted tabs in a strip of few tabs and of many', async () => {
  const { app, chrome } = await launched()
  try {
    const [first, a, tone, c] = await openTabs(chrome, '/a', '/tone', '/c') as [string, string, string, string]
    await app.evaluate(async ({ webContents }, url) => {
      await webContents.getAllWebContents().find((w) => w.getURL() === url)?.executeJavaScript('window.start()', true)
    }, pageOf('/tone'))
    expect(await waitFor(async () => await chrome.locator(`.tab[data-id="${tone}"] .tab-audio`).count() === 1)).toBe(true)
    await activate(chrome, a)
    await runCommand(chrome, 'tab.pin')
    await activate(chrome, first)
    await shoot(chrome, 'strip-5-pinned-audible')

    await activate(chrome, tone)
    await runCommand(chrome, 'tab.pin') // pinned and audible: the mark on the icon
    expect(await waitFor(async () => await chrome.locator(`.tab[data-id="${tone}"] .tab-sound-mark`).count() === 1)).toBe(true)
    await act(chrome, 'tab.mute', { id: tone })
    expect(await waitFor(async () => await chrome.evaluate((id) => document.querySelector(`.tab[data-id="${id}"] .tab-sound-mark svg`)?.innerHTML.includes('M22 9l-6 6') ?? false, tone))).toBe(true)
    await activate(chrome, c)
    await shoot(chrome, 'strip-pinned-muted')

    // Many tabs in a narrow window: the tabs shrink to their minimum and the strip scrolls; pinned ones keep their width.
    await app.evaluate(({ BaseWindow }) => { BaseWindow.getAllWindows()[0]?.setSize(700, 600) })
    for (let more = 0; more < 9; more += 1) await chrome.click('#new-tab')
    expect(await waitFor(async () => (await order(chrome)).length === 13)).toBe(true)
    const widths = await chrome.evaluate(() => [...document.querySelectorAll<HTMLElement>('.tab')].map((el) => ({ pinned: el.classList.contains('pinned'), width: Math.round(el.getBoundingClientRect().width) })))
    expect(widths.filter((w) => w.pinned).every((w) => w.width === 36)).toBe(true)
    expect(Math.min(...widths.filter((w) => !w.pinned).map((w) => w.width))).toBeGreaterThanOrEqual(44)
    await shoot(chrome, 'strip-13-narrow')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
