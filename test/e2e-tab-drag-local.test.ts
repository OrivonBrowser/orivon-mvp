// Tab dragging where a window knows nothing of the screen (a native Wayland session), forced on a virtual X
// display by the test build's ORIVON_TEST_LOCAL_POINTER. The drag is driven with the real mouse of the
// source's chrome page; another window's chrome seeing the pointer arrive is a real mouse move over that page,
// which is what the compositor delivers to the window under the pointer at the moment the button is released.
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
/** How many views the oldest window holds: one more while the drag's preview is in it. */
const viewCount = async (app: ElectronApplication): Promise<number> => await app.evaluate(({ BaseWindow }) => {
  const [oldest] = [...BaseWindow.getAllWindows()].sort((a, b) => a.id - b.id)
  return oldest?.contentView.children.length ?? 0
})

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

/** Presses on the dragged tab and moves to `to`, still holding. */
async function dragTo (pair: Pair, to: { x: number, y: number }): Promise<void> {
  const tab = await box(pair.first, `.tab[data-id="${pair.dragged}"]`)
  await pair.first.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2)
  await pair.first.mouse.down()
  await pair.first.mouse.move(to.x, to.y, { steps: 10 })
}

const pageCentre = async (app: ElectronApplication): Promise<{ x: number, y: number }> => await app.evaluate(({ BaseWindow }) => {
  const [oldest] = [...BaseWindow.getAllWindows()].sort((a, b) => a.id - b.id)
  const bounds = oldest?.getContentBounds() ?? { width: 0, height: 0 }
  return { x: bounds.width / 2, y: bounds.height / 2 }
})

it('shows the preview inside the window, not in a window of its own, and takes it away when the tab is let go', async () => {
  const pair = await launchedPair()
  const { app, first } = pair
  try {
    const before = await viewCount(app)
    await dragTo(pair, await pageCentre(app))
    expect(await waitFor(async () => await viewCount(app) === before + 1)).toBe(true)
    // Nothing floats: the drag opened no window for its preview.
    expect(await windowCount(app)).toBe(2)

    await first.mouse.up()
    expect(await waitFor(async () => await viewCount(app) <= before)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('moves a tab into the window whose strip the pointer arrived on, at the slot under it', async () => {
  const pair = await launchedPair()
  const { app, first, second, dragged, travelling } = pair
  try {
    await dragTo(pair, await pageCentre(app))
    // The pointer is over window two's strip, left of its first tab's centre, when the button is let go.
    const target = await box(second, '#tabrow .tab')
    await second.mouse.move(target.x + 8, target.y + target.height / 2)
    await first.mouse.up()

    expect(await waitFor(async () => (await tabIds(second)).includes(dragged))).toBe(true)
    expect(await tabIds(second)).toEqual([dragged, travelling])
    expect(await tabIds(first)).not.toContain(dragged)
    expect(await windowCount(app)).toBe(2)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('moves it all the same when the arrival is told just after the button is let go', async () => {
  const pair = await launchedPair()
  const { app, first, second, dragged, travelling } = pair
  try {
    await dragTo(pair, await pageCentre(app))
    const target = await box(second, '#tabrow .tab')
    await first.mouse.up()
    await delay(40)
    await second.mouse.move(target.x + target.width - 8, target.y + target.height / 2)

    expect(await waitFor(async () => (await tabIds(second)).includes(dragged))).toBe(true)
    expect(await tabIds(second)).toEqual([travelling, dragged])
    expect(await windowCount(app)).toBe(2)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('opens a window of its own when no window saw the pointer arrive', async () => {
  const pair = await launchedPair()
  const { app, first, dragged } = pair
  try {
    await dragTo(pair, await pageCentre(app))
    await first.mouse.up()

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

it('does nothing when a tab is let go over its own window\'s toolbar', async () => {
  const pair = await launchedPair()
  const { app, first, dragged } = pair
  try {
    const strip = await box(first, '#tabrow')
    // Past the strip's tear distance and still inside the strip-and-toolbar rows.
    await dragTo(pair, { x: 400, y: strip.y + strip.height + 22 })
    await first.mouse.up()

    await delay(ABSENCE_SETTLE_MS)
    expect(await tabIds(first)).toContain(dragged)
    expect(await windowCount(app)).toBe(2)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('still splits when a tab is let go on the edge of its own window\'s page', async () => {
  const pair = await launchedPair()
  const { app, first, dragged } = pair
  try {
    const active = (await tabIds(first)).at(-1) as string
    // The dashboard tab is dragged while `/dragged` is in front: down onto the left edge of the page.
    const dashboard = (await tabIds(first))[0] as string
    expect(active).toBe(dragged)
    const tab = await box(first, `.tab[data-id="${dashboard}"]`)
    await first.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2)
    await first.mouse.down()
    await first.mouse.move(40, tab.y + 300, { steps: 12 })
    await first.mouse.up()

    const joined = async (): Promise<string[]> => await first.evaluate(() => [...document.querySelectorAll<HTMLElement>('.tab.joined')].map((el) => el.dataset['id'] ?? ''))
    expect(await waitFor(async () => (await joined()).join() === [dashboard, dragged].join())).toBe(true)
    expect(await windowCount(app)).toBe(2)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
