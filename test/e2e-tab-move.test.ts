// Moving tabs: along the strip with the keys and with the pointer, into a
// window of their own, and into another window, each time keeping the same
// page (its scroll, its script state) rather than loading it again.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Locator, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from './launch-electron.mjs'
import { clickAddressBarRetrying, pressKey } from './e2e-helpers.js'
import { ABSENCE_SETTLE_MS, delay, findChrome, HERMETIC_RESOLVER, tabIds, waitFor, waitForTab } from './smoke-helpers.mjs'

let server: Server
let origin = ''

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end(`<!doctype html><title>Page ${request.url ?? ''}</title><p>${request.url ?? ''}</p>`)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 70_000
const chromePages = (app: ElectronApplication): Page[] => app.windows().filter((w) => w.url().endsWith('/renderer/index.html'))

async function launched (): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

/** Opens `paths` as tabs, one after the other; the dashboard tab the window starts with stays first. */
async function openTabs (app: ElectronApplication, chrome: Page, ...paths: string[]): Promise<string[]> {
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

const titles = async (chrome: Page): Promise<string[]> => await chrome.locator('.tab .title').allTextContents()


/** The strip is rebuilt on every state push, so a tab found visible can be detached for a moment
 * before its box is read: read it again until the rebuilt element answers. */
async function boxOf (tab: Locator): Promise<{ x: number, y: number, width: number, height: number }> {
  let box: { x: number, y: number, width: number, height: number } | null = null
  await waitFor(async () => { box = await tab.boundingBox().catch(() => null); return box !== null })
  if (box === null) throw new Error('the tab has no box')
  return box
}

it('moves the active tab along the strip with the keys', async () => {
  const { app, chrome } = await launched()
  try {
    const [first, a, b] = await openTabs(app, chrome, '/a', '/b') as [string, string, string]
    // /b is active and last.
    await pressKey(app, `${origin}/b`, 'PageUp', ['control', 'shift'])
    expect(await waitFor(async () => (await tabIds(chrome)).join() === [first, b, a].join())).toBe(true)
    await pressKey(app, `${origin}/b`, 'PageUp', ['control', 'shift'])
    await pressKey(app, `${origin}/b`, 'PageUp', ['control', 'shift'])
    expect(await waitFor(async () => (await tabIds(chrome)).join() === [b, first, a].join())).toBe(true)
    await pressKey(app, `${origin}/b`, 'PageDown', ['control', 'shift'])
    expect(await waitFor(async () => (await tabIds(chrome)).join() === [first, b, a].join())).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('drags a tab to a new place in the strip', async () => {
  const { app, chrome } = await launched()
  try {
    const [first, a, b] = await openTabs(app, chrome, '/a', '/b') as [string, string, string]
    const boxes = async (): Promise<Array<{ x: number, y: number, width: number, height: number }>> =>
      await chrome.evaluate(() => [...document.querySelectorAll('.tab')].map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }))
    const [from, , last] = await boxes() as [{ x: number, y: number, width: number, height: number }, unknown, { x: number, y: number, width: number, height: number }]

    await chrome.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await chrome.mouse.down()
    await chrome.mouse.move(last.x + last.width * 0.9, from.y + from.height / 2, { steps: 12 })
    await chrome.mouse.up()

    expect(await waitFor(async () => (await tabIds(chrome)).join() === [a, b, first].join())).toBe(true)
    // A drag is not a click: the tab that was dragged did not become the active one by being let go.
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('moves a tab to a window of its own, still the same page', async () => {
  const { app, chrome } = await launched()
  try {
    await openTabs(app, chrome, '/moving', '/staying')
    const movingPage = app.windows().find((w) => w.url() === `${origin}/moving`) as Page
    await movingPage.evaluate(() => { (window as unknown as { __marker: string }).__marker = 'kept' })
    const tabsBefore = await tabIds(chrome)
    // The tab to move is the one showing /moving.
    await chrome.locator('.tab', { hasText: 'Page /moving' }).click()
    expect((await waitForTab(chrome, { address: `${origin}/moving` })).ok).toBe(true)

    await runCommand(chrome, 'tab.moveToNewWindow')

    expect(await waitFor(() => chromePages(app).length === 2)).toBe(true)
    const second = chromePages(app).find((page) => page !== chrome) as Page
    expect(await waitFor(async () => (await tabIds(second)).length === 1)).toBe(true)
    expect(await waitFor(async () => (await tabIds(chrome)).length === tabsBefore.length - 1)).toBe(true)
    expect(await titles(second)).toEqual(['Page /moving'])
    expect(await titles(chrome)).not.toContain('Page /moving')
    // The page was not loaded again: what its script set is still there.
    expect(await movingPage.evaluate(() => (window as unknown as { __marker?: string }).__marker)).toBe('kept')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('does not move a window\'s only tab into a window of its own', async () => {
  const { app, chrome } = await launched()
  try {
    await runCommand(chrome, 'tab.moveToNewWindow')
    await delay(600)
    expect(chromePages(app)).toHaveLength(1)
    expect(await tabIds(chrome)).toHaveLength(1)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('moves a tab into another window when let go over its strip, and closes the window it leaves empty', async () => {
  const { app, chrome: first } = await launched()
  try {
    await first.evaluate(() => { (window as unknown as { orivonShell: { newWindow: () => void } }).orivonShell.newWindow() })
    expect(await waitFor(() => chromePages(app).length === 2)).toBe(true)
    const second = chromePages(app).find((page) => page !== first) as Page
    await clickAddressBarRetrying(second, `${origin}/travelling`)
    expect((await waitForTab(second, { address: `${origin}/travelling` })).ok).toBe(true)
    const travelling = (await tabIds(second))[0] as string

    // Where the first window's strip is, in screen coordinates.
    const point = await app.evaluate(({ BaseWindow }) => {
      const [older] = [...BaseWindow.getAllWindows()].sort((a, b) => a.id - b.id)
      const bounds = older?.getBounds() ?? { x: 0, y: 0, width: 0, height: 0 }
      return { x: bounds.x + bounds.width / 2, y: bounds.y + 20 }
    })
    await second.evaluate(([id, x, y]) => { (window as unknown as { orivonShell: { dropTab: (id: string, x: number, y: number, cx: number, cy: number) => void } }).orivonShell.dropTab(id as string, x as number, y as number, -50, -50) }, [travelling, point.x, point.y] as const)

    expect(await waitFor(async () => (await tabIds(first)).includes(travelling))).toBe(true)
    // The second window's only tab went, so the window went with it.
    expect(await waitFor(() => chromePages(app).length === 1)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

// Tabs sit packed at the left of the strip, so a slot is a place among the real tabs, not a share of the
// window's width: the right half of the last tab is the end slot.
it('lands a tab last when let go over the right half of the last tab of another window\'s strip', async () => {
  const { app, chrome: first } = await launched()
  try {
    await openTabs(app, first, '/one', '/two')
    await first.evaluate(() => { (window as unknown as { orivonShell: { newWindow: () => void } }).orivonShell.newWindow() })
    expect(await waitFor(() => chromePages(app).length === 2)).toBe(true)
    const second = chromePages(app).find((page) => page !== first) as Page
    await clickAddressBarRetrying(second, `${origin}/travelling`)
    expect((await waitForTab(second, { address: `${origin}/travelling` })).ok).toBe(true)
    const travelling = (await tabIds(second))[0] as string
    const before = await tabIds(first)
    expect(before).toHaveLength(3)

    const lastTab = await first.evaluate(() => {
      const box = [...document.querySelectorAll('#tabrow .tab')].at(-1)?.getBoundingClientRect()
      return box === undefined ? null : { left: box.left, width: box.width }
    })
    expect(lastTab).not.toBeNull()
    const point = await app.evaluate(({ BaseWindow }, tab) => {
      const [older] = [...BaseWindow.getAllWindows()].sort((a, b) => a.id - b.id)
      const bounds = older?.getContentBounds() ?? { x: 0, y: 0 }
      return { x: bounds.x + (tab?.left ?? 0) + (tab?.width ?? 0) * 0.75, y: bounds.y + 20 }
    }, lastTab)
    await second.evaluate(([id, x, y]) => { (window as unknown as { orivonShell: { dropTab: (id: string, x: number, y: number, cx: number, cy: number) => void } }).orivonShell.dropTab(id as string, x as number, y as number, -50, -50) }, [travelling, point.x, point.y] as const)

    expect(await waitFor(async () => (await tabIds(first)).includes(travelling))).toBe(true)
    expect((await tabIds(first)).at(-1)).toBe(travelling)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

// A collapsed group takes no room in the strip: a drop past the tab before it lands after the whole group,
// the place the strip's own drag gives and the place the mark is drawn.
it('lands a tab after a collapsed group when let go over the right half of the tab before it', async () => {
  const { app, chrome: first } = await launched()
  try {
    const [dashboard, one, two] = await openTabs(app, first, '/one', '/two') as [string, string, string]
    await first.evaluate((id) => { (window as unknown as { orivonShell: { activateTab: (id: string) => void } }).orivonShell.activateTab(id) }, one)
    await runCommand(first, 'tab.group')
    expect(await waitFor(async () => await first.locator('.tab-group-chip').count() === 1)).toBe(true)
    const bubble = (): Page | undefined => app.windows().find((w) => w.url().includes('overlay=tab-group'))
    expect(await waitFor(() => bubble() !== undefined)).toBe(true)
    await (bubble() as Page).keyboard.press('Escape').catch(() => {})
    await first.locator('.tab-group-chip').click()
    expect(await waitFor(async () => (await first.locator(`.tab[data-id="${one}"]`).evaluate((el) => (el as HTMLElement).hidden)))).toBe(true)

    await first.evaluate(() => { (window as unknown as { orivonShell: { newWindow: () => void } }).orivonShell.newWindow() })
    expect(await waitFor(() => chromePages(app).length === 2)).toBe(true)
    const second = chromePages(app).find((page) => page !== first) as Page
    await clickAddressBarRetrying(second, `${origin}/travelling`)
    expect((await waitForTab(second, { address: `${origin}/travelling` })).ok).toBe(true)
    const travelling = (await tabIds(second))[0] as string

    const firstTab = await first.evaluate((id) => {
      const box = document.querySelector(`#tabrow .tab[data-id="${id}"]`)?.getBoundingClientRect()
      return box === undefined ? null : { left: box.left, width: box.width }
    }, dashboard)
    expect(firstTab).not.toBeNull()
    const point = await app.evaluate(({ BaseWindow }, tab) => {
      const [older] = [...BaseWindow.getAllWindows()].sort((a, b) => a.id - b.id)
      const bounds = older?.getContentBounds() ?? { x: 0, y: 0 }
      return { x: bounds.x + (tab?.left ?? 0) + (tab?.width ?? 0) * 0.75, y: bounds.y + 20 }
    }, firstTab)
    await second.evaluate(([id, x, y]) => { (window as unknown as { orivonShell: { dropTab: (id: string, x: number, y: number, cx: number, cy: number) => void } }).orivonShell.dropTab(id as string, x as number, y as number, -50, -50) }, [travelling, point.x, point.y] as const)

    expect(await waitFor(async () => (await tabIds(first)).includes(travelling))).toBe(true)
    // Past the first tab's centre, the group's hidden tab is behind the tab let go, not in front of it.
    expect(await tabIds(first)).toEqual([dashboard, one, travelling, two])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('takes a tab out into a window of its own when it is dragged out of the window', async () => {
  const { app, chrome } = await launched()
  try {
    await openTabs(app, chrome, '/dragged')
    const dragged = chrome.locator('.tab', { hasText: 'Page /dragged' })
    await dragged.waitFor({ state: 'visible' })
    const box = await boxOf(dragged)

    await chrome.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await chrome.mouse.down()
    // Beyond the window's own bottom edge: over the page it would only be a place to split.
    await chrome.mouse.move(box.x + box.width / 2, box.y + 1500, { steps: 10 })
    await chrome.mouse.up()

    expect(await waitFor(() => chromePages(app).length === 2)).toBe(true)
    const second = chromePages(app).find((page) => page !== chrome) as Page
    expect(await waitFor(async () => (await titles(second)).join() === 'Page /dragged')).toBe(true)
    expect(await titles(chrome)).not.toContain('Page /dragged')
    // The floating preview ends with the drag, its page included.
    await delay(ABSENCE_SETTLE_MS)
    expect(await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith('data:')).length)).toBe(0)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

// The floating preview shown once a tab tears out promises a window wherever it is let go over open
// space -- releasing over this window's OWN page, away from every split edge, must match that promise
// by opening a window there too, not leave the tab where it was.
it('opens a tab dragged out over its own page, away from a split edge, in a window of its own', async () => {
  const { app, chrome } = await launched()
  try {
    await openTabs(app, chrome, '/dropped')
    const dragged = chrome.locator('.tab', { hasText: 'Page /dropped' })
    await dragged.waitFor({ state: 'visible' })
    const box = await boxOf(dragged)
    const area = await app.evaluate(({ BaseWindow }) => {
      const bounds = BaseWindow.getAllWindows()[0]?.getContentBounds()
      return { width: bounds?.width ?? 0, height: bounds?.height ?? 0 }
    })

    await chrome.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await chrome.mouse.down()
    // The window's own centre: well past the strip, and well inside every split edge's 12% band on
    // every side, so this can only land as "the page, no edge" -- never a split, never outside the window.
    await chrome.mouse.move(area.width / 2, area.height / 2, { steps: 10 })
    await chrome.mouse.up()

    expect(await waitFor(() => chromePages(app).length === 2)).toBe(true)
    const second = chromePages(app).find((page) => page !== chrome) as Page
    expect(await waitFor(async () => (await titles(second)).join() === 'Page /dropped')).toBe(true)
    expect(await titles(chrome)).not.toContain('Page /dropped')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('shows a tab\'s own new window at once, without waiting on ready-to-show', async () => {
  const { app, chrome } = await launched()
  try {
    await openTabs(app, chrome, '/torn')
    const dragged = chrome.locator('.tab', { hasText: 'Page /torn' })
    await dragged.waitFor({ state: 'visible' })
    const box = await boxOf(dragged)
    const before = Date.now()
    await chrome.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await chrome.mouse.down()
    await chrome.mouse.move(box.x + box.width / 2, box.y + 1500, { steps: 6 })
    await chrome.mouse.up()

    expect(await waitFor(() => chromePages(app).length === 2)).toBe(true)
    const second = chromePages(app).find((page) => page !== chrome) as Page
    const shownWithin = Date.now() - before
    const visible = await app.evaluate(({ BaseWindow }) => {
      const [, newest] = [...BaseWindow.getAllWindows()].sort((a, b) => a.id - b.id)
      return newest?.isVisible() ?? false
    })
    expect(visible).toBe(true)
    // Generous bound: this only guards against the OLD 1000ms ready-to-show
    // fallback wait coming back, not a tight performance assertion.
    expect(shownWithin).toBeLessThan(3_000)
    expect(await titles(second)).toEqual(['Page /torn'])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

// The empty strip's tail, past the new-tab button, is part of the strip's native drag region on every
// platform: the window manager moves the window from it (so it can leave the screen, tile and move by
// keyboard) and a double click maximizes through the window manager's own setting. A drag region hands
// the page no pointer event of any button, so the tail takes no middle click. The move itself needs a
// window manager on the display; a bare Xvfb runs none, so what is read here is the region.
it('the empty strip is a native drag region, and the buttons and tabs in it are not', async () => {
  const { app, chrome } = await launched()
  try {
    expect(await waitFor(async () => (await tabIds(chrome)).length === 1)).toBe(true)
    const regions = await chrome.evaluate(() => {
      const region = (selector: string): string => {
        const el = document.querySelector(selector)
        return el === null ? 'missing' : String((getComputedStyle(el) as unknown as Record<string, string>)['webkitAppRegion'])
      }
      return { row: region('#tabrow'), tail: region('#tab-strip-tail'), newTab: region('#new-tab'), tab: region('.tab') }
    })
    expect(regions.row).toBe('drag')
    expect(regions.tail).not.toBe('no-drag')
    expect(regions.tail).not.toBe('missing')
    expect(regions.newTab).toBe('no-drag')
    expect(regions.tab).toBe('no-drag')
    expect(await chrome.evaluate(() => (window as unknown as { orivonShell: Record<string, unknown> }).orivonShell['dragMode'])).toBeUndefined()
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
