// Tab dragging with the browser's own drag and drop, where a window knows nothing of the screen (a native Wayland
// session), forced on a virtual X display by the test build's ORIVON_TEST_LOCAL_POINTER. The browser's drag itself
// cannot be started from a script, so each spec fires the events the browser would: the press and `dragstart` on the
// tab in the source chrome, then `dragover`, `drop` and `dragend` carrying a real DataTransfer on the chrome strips and
// the drop catchers, in the order measured on Wayland. The pointer-driven moves are checked with real input
// (docs/development/testing.md).
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from './launch-electron.mjs'
import { clickAddressBarRetrying } from './e2e-helpers.js'
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

const TEST_TIMEOUT_MS = 90_000
const chromePages = (app: ElectronApplication): Page[] => app.windows().filter((w) => w.url().endsWith('/renderer/index.html'))
const windowCount = async (app: ElectronApplication): Promise<number> => await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length)
const catcherPages = (app: ElectronApplication): Page[] => app.windows().filter((w) => w.url().endsWith('/renderer/drop-catcher/index.html'))

interface Pair { app: ElectronApplication, first: Page, second: Page, dragged: string, travelling: string }

/** Window one holds the dashboard and `/dragged`; window two the dashboard and `/travelling`. */
async function launchedPair (): Promise<Pair> {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], env: { ORIVON_TEST_LOCAL_POINTER: '1' } })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  const first = findChrome(app)
  await first.click('#new-tab')
  await clickAddressBarRetrying(first, `${origin}/dragged`)
  expect((await waitForTab(first, { address: `${origin}/dragged` })).ok).toBe(true)
  const dragged = (await tabIds(first)).at(-1) as string

  await first.evaluate(() => { (window as unknown as { orivonShell: { newWindow: () => void } }).orivonShell.newWindow() })
  expect(await waitFor(() => chromePages(app).length === 2)).toBe(true)
  const second = chromePages(app).find((page) => page !== first) as Page
  await clickAddressBarRetrying(second, `${origin}/travelling`)
  expect((await waitForTab(second, { address: `${origin}/travelling` })).ok).toBe(true)
  const travelling = (await tabIds(second))[0] as string
  return { app, first, second, dragged, travelling }
}

async function box (page: Page, selector: string): Promise<{ x: number, y: number, width: number, height: number }> {
  let found: { x: number, y: number, width: number, height: number } | null = null
  await waitFor(async () => { found = await page.locator(selector).first().boundingBox().catch(() => null); return found !== null })
  if (found === null) throw new Error(`${selector} has no box`)
  return found
}

/** How many views the windows hold in all: a drag's catchers are in them for its length only. */
const viewCount = async (app: ElectronApplication): Promise<number> => await app.evaluate(({ BaseWindow }) =>
  BaseWindow.getAllWindows().reduce((sum, window) => sum + window.contentView.children.length, 0))

async function resizeSecondWindow (app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BaseWindow }) => { [...BaseWindow.getAllWindows()].sort((a, b) => a.id - b.id)[1]?.setSize(700, 520) })
  await delay(300)
}

/** Presses on a tab and fires the `dragstart` the browser would, returning the nonce the drag carries. */
async function startDrag (chrome: Page, id: string): Promise<string> {
  return await chrome.evaluate((tabId) => {
    const shell = (window as unknown as { orivonShell: { nativeTabDragType: string | null } }).orivonShell
    const tab = document.querySelector(`#tabrow .tab[data-id="${tabId}"]`) as HTMLElement
    const box = tab.getBoundingClientRect()
    const at = { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: box.left + 40, clientY: box.top + 10 }
    tab.dispatchEvent(new PointerEvent('pointerdown', at))
    tab.dispatchEvent(new PointerEvent('pointermove', { ...at, clientX: box.left + 50 }))
    const transfer = new DataTransfer()
    tab.dispatchEvent(new DragEvent('dragstart', { ...at, dataTransfer: transfer }))
    return transfer.getData(shell.nativeTabDragType ?? '')
  }, id)
}

/** Fires a drag event carrying the tab type and `nonce` at a point of the page; false when the page took it (cancelled it). */
async function dragEvent (page: Page, type: 'dragover' | 'drop' | 'dragleave', nonce: string, at: { x: number, y: number }): Promise<boolean> {
  return await page.evaluate(({ eventType, value, x, y }) => {
    const shell = (window as unknown as { orivonShell?: { nativeTabDragType: string | null } }).orivonShell
    const transfer = new DataTransfer()
    transfer.setData(shell?.nativeTabDragType ?? 'application/x-orivon-tab-drag', value)
    const target = document.elementFromPoint(x, y) ?? document.body
    return target.dispatchEvent(new DragEvent(eventType, { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: x, clientY: y }))
  }, { eventType: type, value: nonce, x: at.x, y: at.y })
}

/** The drag ending in the window it began in. */
async function endDrag (chrome: Page, id: string): Promise<void> {
  await chrome.evaluate((tabId) => {
    document.querySelector(`#tabrow .tab[data-id="${tabId}"]`)?.dispatchEvent(new DragEvent('dragend', { bubbles: true }))
  }, id)
}

/** The catcher over the window whose chrome is `chrome`: the one as wide as its content. The chrome view is wider than the window while a tab is pressed, but its document keeps the window's width. */
async function catcherOver (app: ElectronApplication, chrome: Page): Promise<Page> {
  const width = await chrome.evaluate(() => document.body.clientWidth)
  let found: Page | undefined
  await waitFor(async () => {
    for (const page of catcherPages(app)) {
      if (await page.evaluate(() => window.innerWidth).catch(() => -1) === width) found = page
    }
    return found !== undefined
  })
  if (found === undefined) throw new Error('no drop catcher over that window')
  return found
}

/** Fires `dragover` at the strip of `chrome` until it takes the drag: main's word that one is on may still be on its way. */
async function waitUntilTaken (chrome: Page, nonce: string, at: { x: number, y: number }): Promise<void> {
  expect(await waitFor(async () => !(await dragEvent(chrome, 'dragover', nonce, at)))).toBe(true)
}

const markState = async (chrome: Page): Promise<{ shown: boolean, left: number }> => await chrome.evaluate(() => {
  const mark = document.querySelector<HTMLElement>('.drop-mark')
  return { shown: mark !== null && !mark.hidden, left: mark === null ? -1 : parseFloat(mark.style.left) }
})

it('reorders the source strip at the slot under the pointer, marked there while it is over, with the tab\'s place kept as a gap', async () => {
  const pair = await launchedPair()
  const { app, first, dragged } = pair
  try {
    const dashboard = (await tabIds(first))[0] as string
    const row = await box(first, '#tabrow')
    const last = await box(first, `.tab[data-id="${dragged}"]`)
    const nonce = await startDrag(first, dashboard)
    expect(nonce).not.toBe('')
    expect(await waitFor(async () => await first.evaluate((id) => document.querySelector(`.tab[data-id="${id}"]`)?.classList.contains('drag-source') === true, dashboard))).toBe(true)

    const at = { x: last.x + last.width - 8, y: last.y + last.height / 2 }
    expect(await dragEvent(first, 'dragover', nonce, at)).toBe(false)
    const mark = await markState(first)
    expect(mark.shown).toBe(true)
    expect(Math.abs(mark.left - (last.x + last.width - row.x))).toBeLessThanOrEqual(4)

    await dragEvent(first, 'drop', nonce, at)
    expect((await markState(first)).shown).toBe(false)
    await endDrag(first, dashboard)

    expect(await waitFor(async () => (await tabIds(first)).join() === [dragged, dashboard].join())).toBe(true)
    expect(await first.evaluate(() => document.querySelectorAll('.tab.drag-source').length)).toBe(0)
    expect(await windowCount(app)).toBe(2)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('moves a tab into the window whose strip took the drop, at the slot its mark showed, and takes every catcher down', async () => {
  const pair = await launchedPair()
  const { app, first, second, dragged, travelling } = pair
  try {
    const before = await viewCount(app)
    const nonce = await startDrag(first, dragged)
    expect(await waitFor(async () => await viewCount(app) === before + 2)).toBe(true)

    const target = await box(second, '#tabrow .tab')
    const row = await box(second, '#tabrow')
    const at = { x: target.x + 8, y: target.y + target.height / 2 }
    await waitUntilTaken(second, nonce, at)
    const mark = await markState(second)
    expect(mark.shown).toBe(true)
    expect(Math.abs(mark.left - (target.x - row.x))).toBeLessThanOrEqual(4)

    await dragEvent(second, 'drop', nonce, at)
    await endDrag(first, dragged)

    expect(await waitFor(async () => (await tabIds(second)).includes(dragged))).toBe(true)
    expect(await tabIds(second)).toEqual([dragged, travelling])
    expect(await tabIds(first)).not.toContain(dragged)
    expect((await markState(second)).shown).toBe(false)
    expect(await waitFor(async () => await viewCount(app) === before)).toBe(true)
    expect(await windowCount(app)).toBe(2)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('splits when the source catcher took the drop on an edge of its page', async () => {
  const pair = await launchedPair()
  const { app, first, dragged } = pair
  try {
    await resizeSecondWindow(app)
    const dashboard = (await tabIds(first))[0] as string
    const nonce = await startDrag(first, dashboard)
    const catcher = await catcherOver(app, first)

    expect(await dragEvent(catcher, 'dragover', nonce, { x: 20, y: 300 })).toBe(false)
    await dragEvent(catcher, 'drop', nonce, { x: 20, y: 300 })
    await endDrag(first, dashboard)

    const joined = async (): Promise<string[]> => await first.evaluate(() => [...document.querySelectorAll<HTMLElement>('.tab.joined')].map((el) => el.dataset['id'] ?? ''))
    expect(await waitFor(async () => (await joined()).join() === [dashboard, dragged].join())).toBe(true)
    expect(await windowCount(app)).toBe(2)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('opens a window of its own for a drop on the middle of the source page', async () => {
  const pair = await launchedPair()
  const { app, first, dragged } = pair
  try {
    await resizeSecondWindow(app)
    const nonce = await startDrag(first, dragged)
    const catcher = await catcherOver(app, first)
    await dragEvent(catcher, 'drop', nonce, { x: 400, y: 300 })
    await endDrag(first, dragged)

    expect(await waitFor(async () => await windowCount(app) === 3)).toBe(true)
    expect(await waitFor(async () => chromePages(app).length === 3)).toBe(true)
    expect(await tabIds(first)).not.toContain(dragged)
    const opened = chromePages(app).find((page) => page !== first && page !== pair.second) as Page
    expect(await waitFor(async () => (await tabIds(opened)).join() === dragged)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('opens a window of its own for a drop on another window\'s page, never moving the tab into it', async () => {
  const pair = await launchedPair()
  const { app, first, second, dragged, travelling } = pair
  try {
    await resizeSecondWindow(app)
    const nonce = await startDrag(first, dragged)
    const catcher = await catcherOver(app, second)
    expect(await dragEvent(catcher, 'dragover', nonce, { x: 20, y: 200 })).toBe(false)
    await dragEvent(catcher, 'drop', nonce, { x: 20, y: 200 })
    await endDrag(first, dragged)

    expect(await waitFor(async () => await windowCount(app) === 3)).toBe(true)
    expect(await tabIds(second)).toEqual([travelling])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('opens a window of its own when the drag ends with nothing having taken it', async () => {
  const pair = await launchedPair()
  const { app, first, dragged } = pair
  try {
    await startDrag(first, dragged)
    await endDrag(first, dragged)

    expect(await waitFor(async () => await windowCount(app) === 3)).toBe(true)
    expect(await tabIds(first)).not.toContain(dragged)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('changes nothing when Escape follows the end of a drag nothing took', async () => {
  const pair = await launchedPair()
  const { app, first, dragged } = pair
  try {
    const before = await viewCount(app)
    expect(await startDrag(first, dragged)).not.toBe('')
    expect(await waitFor(async () => await viewCount(app) === before + 2)).toBe(true)
    await endDrag(first, dragged)
    await delay(100)
    await first.evaluate(() => { window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' })) })

    await delay(ABSENCE_SETTLE_MS)
    expect(await tabIds(first)).toContain(dragged)
    expect(await windowCount(app)).toBe(2)
    expect(await viewCount(app)).toBe(before)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('does nothing when a tab is let go over its own window\'s toolbar, and marks nothing there', async () => {
  const pair = await launchedPair()
  const { app, first, dragged } = pair
  try {
    const nonce = await startDrag(first, dragged)
    const at = { x: 400, y: 58 }
    expect(await dragEvent(first, 'dragover', nonce, at)).toBe(false)
    expect((await markState(first)).shown).toBe(false)
    await dragEvent(first, 'drop', nonce, at)
    await endDrag(first, dragged)

    await delay(ABSENCE_SETTLE_MS)
    expect(await tabIds(first)).toContain(dragged)
    expect(await windowCount(app)).toBe(2)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('ignores a drop carrying a nonce that is not the drag\'s, and one on a strip that was told no drag is on', async () => {
  const pair = await launchedPair()
  const { app, first, second, dragged, travelling } = pair
  try {
    expect(await dragEvent(second, 'dragover', 'nobody', { x: 20, y: 20 })).toBe(true)

    const nonce = await startDrag(first, dragged)
    const target = await box(second, '#tabrow .tab')
    const at = { x: target.x + 8, y: target.y + target.height / 2 }
    await waitUntilTaken(second, nonce, at)
    await dragEvent(second, 'drop', 'someone-else', at)
    await delay(ABSENCE_SETTLE_MS)
    expect(await tabIds(second)).toEqual([travelling])
    await dragEvent(second, 'drop', nonce, at)
    await endDrag(first, dragged)
    expect(await waitFor(async () => (await tabIds(second)).includes(dragged))).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('keeps a narrow window\'s toolbar narrow while a pressed tab makes the chrome view wider than the window', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], env: { ORIVON_TEST_LOCAL_POINTER: '1' } })
  try {
    expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
    const chrome = findChrome(app)
    const read = async (): Promise<{ identity: string, view: number, root: number }> => await chrome.evaluate(() => ({
      identity: getComputedStyle(document.querySelector('#identity') as Element).display,
      view: window.innerWidth,
      root: document.body.clientWidth
    }))
    // Wide, the placeholder shows: its hiding below is the narrow layout's doing.
    expect((await read()).identity).not.toBe('none')
    await app.evaluate(({ BaseWindow }) => { BaseWindow.getAllWindows()[0]?.setContentSize(500, 400) })
    expect(await waitFor(async () => (await read()).view === 500)).toBe(true)
    expect((await read()).identity).toBe('none')

    const id = (await tabIds(chrome))[0] as string
    await chrome.evaluate((tabId: string) => {
      const tab = document.querySelector(`#tabrow .tab[data-id="${tabId}"]`) as HTMLElement
      const box = tab.getBoundingClientRect()
      tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: box.left + 20, clientY: box.top + 10 }))
    }, id)
    expect(await waitFor(async () => (await read()).view > 500)).toBe(true)
    expect(await read()).toMatchObject({ identity: 'none', root: 500 })

    await chrome.evaluate(() => { window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 })) })
    expect(await waitFor(async () => (await read()).view === 500)).toBe(true)
    expect((await read()).identity).toBe('none')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
