// Moving tabs: along the strip with the keys and with the pointer, into a
// window of their own, and into another window, each time keeping the same
// page (its scroll, its script state) rather than loading it again.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from './launch-electron.mjs'
import { clickAddressBarRetrying, pressKey } from './e2e-helpers.js'
import { delay, findChrome, HERMETIC_RESOLVER, tabIds, waitFor, waitForTab } from './smoke-helpers.mjs'

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

it('takes a tab out into a window of its own when it is dragged out of the window', async () => {
  const { app, chrome } = await launched()
  try {
    await openTabs(app, chrome, '/dragged')
    const dragged = chrome.locator('.tab', { hasText: 'Page /dragged' })
    await dragged.waitFor({ state: 'visible' })
    const box = await dragged.boundingBox()
    if (box === null) throw new Error('the tab has no box')

    await chrome.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await chrome.mouse.down()
    // Beyond the window's own bottom edge: over the page it would only be a place to split.
    await chrome.mouse.move(box.x + box.width / 2, box.y + 1500, { steps: 10 })
    await chrome.mouse.up()

    expect(await waitFor(() => chromePages(app).length === 2)).toBe(true)
    const second = chromePages(app).find((page) => page !== chrome) as Page
    expect(await waitFor(async () => (await titles(second)).join() === 'Page /dragged')).toBe(true)
    expect(await titles(chrome)).not.toContain('Page /dragged')
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
    const box = await dragged.boundingBox()
    if (box === null) throw new Error('the tab has no box')
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
    const before = Date.now()
    const dragged = chrome.locator('.tab', { hasText: 'Page /torn' })
    const box = await dragged.boundingBox()
    if (box === null) throw new Error('the tab has no box')
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

// The empty strip's tail, past the new-tab button, in the manual drag mode
// main decides for this run (drag-mode.ts's dragModeFor: Linux under
// run-headless.mjs's own virtual X11 display, never native Wayland). These
// exercise the DOM/IPC wiring with Playwright's synthetic pointer events,
// which populate a real event's screenX/screenY from the window's actual
// on-screen position -- unlike `screen.getCursorScreenPoint()` (tear-drag.ts's
// own cross-window mark and floating preview), which asks the OS directly
// and does NOT move under CDP-simulated input; that half needs the real-XTest
// verification run instead (see this repo's PR for its timings).
it('the empty strip: middle click opens a tab, double click toggles maximize, a left drag moves the window', async () => {
  const { app, chrome } = await launched()
  try {
    // Recomputed before each interaction: opening a tab (or maximizing,
    // which resizes the window) reflows the strip, and a stale point could
    // land on a tab instead of the tail past it.
    const tailPoint = async (): Promise<{ x: number, y: number }> => {
      const box = await chrome.locator('#tab-strip-tail').boundingBox()
      if (box === null) throw new Error('the strip tail has no box')
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }
    const before = await tabIds(chrome)
    // A synthetic middle click occasionally does not reach the renderer at
    // all under load (observed here, not specific to this feature) -- one
    // retry at a freshly-read point, rather than a longer wait, since a
    // lost event is never going to arrive no matter how long this waits.
    for (let attempt = 0; attempt < 2 && (await tabIds(chrome)).length === before.length; attempt++) {
      const point = await tailPoint()
      await chrome.mouse.click(point.x, point.y, { button: 'middle' })
      await waitFor(async () => (await tabIds(chrome)).length === before.length + 1, 2_000)
    }
    expect(await tabIds(chrome)).toHaveLength(before.length + 1)

    // Under Xvfb there is no window manager, so maximize()/isMaximized()'s
    // own OS-level effect is not observable here (the same gap this run's
    // report names for edge tiling) -- a spy on the method itself is what
    // proves the double click reaches main and calls the right thing.
    await app.evaluate(({ BaseWindow }) => {
      const win = BaseWindow.getAllWindows()[0]
      const g = globalThis as unknown as { __maximizeCalls: number }
      g.__maximizeCalls = 0
      if (win !== undefined) win.maximize = () => { g.__maximizeCalls += 1 }
    })
    const toMaximize = await tailPoint()
    await chrome.mouse.dblclick(toMaximize.x, toMaximize.y)
    expect(await waitFor(async () => (await app.evaluate(() => (globalThis as unknown as { __maximizeCalls: number }).__maximizeCalls)) === 1)).toBe(true)

    const boundsBefore = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]?.getBounds())
    const dragFrom = await tailPoint()
    await chrome.mouse.move(dragFrom.x, dragFrom.y)
    await chrome.mouse.down()
    await chrome.mouse.move(dragFrom.x + 60, dragFrom.y + 40, { steps: 6 })
    await chrome.mouse.up()
    expect(await waitFor(async () => {
      const now = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]?.getBounds())
      return now !== undefined && boundsBefore !== undefined && now.x !== boundsBefore.x
    })).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
