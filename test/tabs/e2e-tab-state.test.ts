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
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { findChrome, HERMETIC_RESOLVER, tabIds, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

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

// A tab collects a listener from each subsystem that watches it; none may grow with a pin, a group or a move, and
// the count a tab starts with must not print Node's leak warning.
it('pins and unpins a plain, a grouped and a moved tab again and again with no crash and no listener warning', async () => {
  const { app, chrome } = await launched()
  try {
    const [, plain, grouped] = await openTabs(chrome, '/plain', '/grouped') as [string, string, string]
    const toggle = async (): Promise<void> => {
      for (let n = 0; n < 6; n += 1) {
        const before = (await pinnedIds(chrome)).length
        await runCommand(chrome, 'tab.pin')
        expect(await waitFor(async () => (await pinnedIds(chrome)).length !== before), `pin toggle ${String(n)}`).toBe(true)
      }
    }
    await activate(chrome, plain)
    await toggle()
    await activate(chrome, grouped)
    await runCommand(chrome, 'tab.group')
    await toggle()

    // A tab handed over from another window.
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { newWindow: () => void } }).orivonShell.newWindow() })
    expect(await waitFor(() => app.windows().filter((w) => w.url().endsWith('/renderer/index.html')).length === 2)).toBe(true)
    const second = app.windows().filter((w) => w.url().endsWith('/renderer/index.html')).find((page) => page !== chrome) as Page
    await clickAddressBarRetrying(second, `${origin}/moved`)
    expect((await waitForTab(second, { address: `${origin}/moved` })).ok).toBe(true)
    const moved = (await tabIds(second))[0] as string
    const point = await app.evaluate(({ BaseWindow }) => {
      const [older] = [...BaseWindow.getAllWindows()].sort((a, b) => a.id - b.id)
      const bounds = older?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 }
      return { x: bounds.x + bounds.width / 2, y: bounds.y + 20 }
    })
    await second.evaluate(([id, x, y]) => { (window as unknown as { orivonShell: { dropTab: (id: string, x: number, y: number, cx: number, cy: number) => void } }).orivonShell.dropTab(id as string, x as number, y as number, -50, -50) }, [moved, point.x, point.y] as const)
    expect(await waitFor(async () => (await tabIds(chrome)).includes(moved))).toBe(true)
    await activate(chrome, moved)
    await toggle()

    const output = mainOutput(app)
    expect(output).not.toContain('uncaught exception')
    expect(output).not.toContain('MaxListenersExceededWarning')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

// A sleeping tab is a record with a placeholder in place of its page; pinning it from the tab's menu does not wake it.
it('pins and unpins a sleeping tab from its menu again and again with no crash and no listener warning', async () => {
  const { app, chrome } = await launched()
  try {
    // A page under the test driver counts as captured, which keeps it awake: the seam the memory-saver spec uses.
    await app.evaluate(() => { (globalThis as unknown as { __orivonSleepIgnoreCapture: boolean }).__orivonSleepIgnoreCapture = true })
    await app.evaluate(({ Menu }) => { (Menu.prototype as unknown as { popup: () => void }).popup = function (this: unknown) { (globalThis as unknown as { __menu?: unknown }).__menu = this } })
    const [, asleep] = await openTabs(chrome, '/asleep', '/other') as [string, string, string]
    await activate(chrome, asleep)
    await runCommand(chrome, 'tab.sleep')
    expect(await waitFor(async () => await chrome.locator(`.tab.sleeping[data-id="${asleep}"]`).count() === 1)).toBe(true)
    const labels = async (): Promise<string[]> => await app.evaluate(() => ((globalThis as unknown as { __menu?: { items: Array<{ label: string, type: string }> } }).__menu?.items ?? []).filter((item) => item.type !== 'separator').map((item) => item.label))
    const choose = async (label: string): Promise<void> => { await app.evaluate((_, l) => { ((globalThis as unknown as { __menu: { items: Array<{ label: string, click: () => void }> } }).__menu.items.find((item) => item.label === l))?.click() }, label) }

    for (let n = 0; n < 6; n += 1) {
      const label = n % 2 === 0 ? 'Pin Tab' : 'Unpin Tab'
      await app.evaluate(() => { (globalThis as unknown as { __menu?: unknown }).__menu = undefined })
      await chrome.click(`.tab[data-id="${asleep}"]`, { button: 'right' })
      expect(await waitFor(async () => (await labels()).includes(label)), `menu ${String(n)} offers ${label}`).toBe(true)
      await choose(label)
      expect(await waitFor(async () => (await pinnedIds(chrome)).includes(asleep) === (n % 2 === 0)), `pin toggle ${String(n)}`).toBe(true)
    }

    const output = mainOutput(app)
    expect(output).not.toContain('uncaught exception')
    expect(output).not.toContain('MaxListenersExceededWarning')
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

it('gives the tabs the room there is, then scrolls only their run, keeping the buttons and the tab in front in view', async () => {
  const { app, chrome } = await launched()
  try {
    await openTabs(chrome, '/one', '/two')
    const widths = await chrome.evaluate(() => [...document.querySelectorAll<HTMLElement>('.tab')].map((el) => el.getBoundingClientRect().width))
    // With room to spare a tab is as wide as a tab gets, not at its minimum.
    expect(widths.every((width) => width >= 150)).toBe(true)

    for (let n = 0; n < 40; n += 1) {
      await chrome.evaluate((url) => { (window as unknown as { orivonShell: { newTab: (u: string) => void } }).orivonShell.newTab(url) }, `${origin}/many${String(n)}`)
    }
    expect(await waitFor(async () => (await order(chrome)).length >= 43)).toBe(true)
    const layout = await waitFor(async () => await chrome.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('#tab-scroll')
      const row = document.querySelector<HTMLElement>('#tabrow')
      const active = document.querySelector<HTMLElement>('.tab.active')
      if (scroller === null || row === null || active === null) return false
      const bounds = scroller.getBoundingClientRect()
      const at = active.getBoundingClientRect()
      const button = document.querySelector('#new-tab')?.getBoundingClientRect()
      const search = document.querySelector('#tab-search')?.getBoundingClientRect()
      return scroller.scrollWidth > scroller.clientWidth && row.scrollLeft === 0 &&
        at.left >= bounds.left - 1 && at.right <= bounds.right + 1 &&
        button !== undefined && button.left >= bounds.right - 1 && search !== undefined && search.right <= row.getBoundingClientRect().right
    }))
    expect(layout, 'the tab in front is in view, and the buttons sit after the scrolling run').toBe(true)

    // A plain mouse wheel only turns up and down: over the strip it scrolls the tabs along.
    const firstTab = (await order(chrome))[0] as string
    await chrome.click(`.tab[data-id="${firstTab}"]`)
    expect(await waitFor(async () => await chrome.evaluate(() => (document.querySelector<HTMLElement>('#tab-scroll')?.scrollLeft ?? 1) === 0))).toBe(true)
    const strip = await chrome.evaluate(() => {
      const box = document.querySelector('#tab-scroll')?.getBoundingClientRect()
      return box === undefined ? null : { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    })
    await chrome.mouse.move(strip?.x ?? 0, strip?.y ?? 0)
    await chrome.mouse.wheel(0, 400)
    expect(await waitFor(async () => await chrome.evaluate(() => (document.querySelector<HTMLElement>('#tab-scroll')?.scrollLeft ?? 0) > 0)), 'the wheel scrolled the strip').toBe(true)
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
    // The original holds three entries (the new-tab page, /one, /two) and the copy the two real pages: the new-tab page is not
    // carried, since a copy may sit in a session that cannot load it. Each stands on its last entry: a copy made while its own
    // load was still running would hold a duplicate /two, and its first Back would stay on /two.
    const same = await waitFor(async () => await app.evaluate(({ webContents }, url) => {
      const wcs = webContents.getAllWebContents().filter((w) => w.getURL() === url && !w.isLoading())
      if (wcs.length !== 2) return false
      const lengths = wcs.map((w) => w.navigationHistory.getAllEntries().length).sort()
      return lengths[0] === 2 && lengths[1] === 3 && wcs.every((w) => {
        const entries = w.navigationHistory.getAllEntries().map((entry) => entry.url)
        return w.navigationHistory.getActiveIndex() === entries.length - 1 && entries.at(-2)?.endsWith('/one') === true && entries.at(-1) === url
      })
    }, pageOf('/two')))
    expect(same, `copy ${copy} does not hold the original's pages`).toBe(true)
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
    expect(await labels()).toEqual(['New Tab to the Right', 'Reload', 'Duplicate', 'Pin Tab', 'Mute Tab', 'Put Tab to Sleep', 'Add Tab to New Group', 'Share', 'Split with', 'Move Tab to New Window', 'Close Tab', 'Close Other Tabs', 'Close Tabs to the Right', 'Reopen Closed Tab', 'Bookmark All Tabs…'])
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

    // An inactive tab too narrow for a title has no close button: a click near its centred icon must activate it, never close it.
    const unpinned = (await order(chrome)).filter((id) => ![first, a, tone].includes(id))
    const target = unpinned[1] as string
    for (const width of [44, 62]) {
      // The strip is rebuilt on every state push, so the width is set once the tab in front is settled.
      await activate(chrome, c)
      expect(await waitFor(async () => await chrome.evaluate((id) => document.querySelector('.tab.active')?.getAttribute('data-id') === id, c))).toBe(true)
      await chrome.evaluate(([id, px]) => {
        const el = document.querySelector<HTMLElement>(`.tab[data-id="${id as string}"]`)
        if (el === null) return
        el.style.flex = `0 0 ${String(px)}px`
        el.style.minWidth = `${String(px)}px`
        el.style.maxWidth = `${String(px)}px`
      }, [target, width] as const)
      const read = async (): Promise<{ close: string, x: number, y: number } | null> => await chrome.evaluate((id) => {
        const el = document.querySelector<HTMLElement>(`.tab[data-id="${id}"]`)
        const close = el?.querySelector('.close')
        if (el === null || close === null || close === undefined) return null
        const box = el.getBoundingClientRect()
        return { close: getComputedStyle(close).display, x: box.left + box.width / 2 + 8, y: box.top + box.height / 2 }
      }, target)
      const found = await read()
      expect(found?.close, `inactive close button at ${String(width)}px`).toBe('none')
      const count = (await order(chrome)).length
      await chrome.mouse.click(found?.x ?? 0, found?.y ?? 0)
      expect(await waitFor(async () => await chrome.evaluate((id) => document.querySelector('.tab.active')?.getAttribute('data-id') === id, target)), `a click at ${String(width)}px activates the tab`).toBe(true)
      expect((await order(chrome)).length).toBe(count)
    }
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
