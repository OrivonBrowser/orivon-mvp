// Split view in the running shell: two tabs side by side or stacked, each in
// its pane, with a divider that resizes, a pane that is the one the person is in,
// and the gestures that make and unmake one. Read off the real window: which
// views are in it, and where.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import pngjs from 'pngjs'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from './launch-electron.mjs'
import { clickAddressBarRetrying } from './e2e-helpers.js'
import { delay, findChrome, HERMETIC_RESOLVER, tabIds, waitFor, waitForTab } from './smoke-helpers.mjs'
import type { DevGrantRequest } from '../src/main/dev/dev-grant.js'
import type { Manifest } from '../src/contracts/index.js'

const { PNG } = pngjs

let server: Server
let appServer: Server
let origin = ''
let appOrigin = ''

/** Every page is one green, with a link, so a pane that paints nothing is told from one that paints its page. */
const PAGE_GREEN = [30, 140, 90]
const page = (request: IncomingMessage, response: ServerResponse): void => {
  response.setHeader('content-type', 'text/html')
  response.end(`<!doctype html><title>Page ${request.url ?? ''}</title><body style="margin:0;height:100vh;background:rgb(${PAGE_GREEN.join(',')})"><p>${request.url ?? ''}</p><a id="go" href="${request.url ?? ''}-link">link</a></body>`)
}

beforeAll(async () => {
  server = createServer(page)
  appServer = createServer(page)
  await Promise.all([server, appServer].map(async (each) => { await new Promise<void>((resolve) => { each.listen(0, '127.0.0.1', resolve) }) }))
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  appOrigin = `http://127.0.0.1:${String((appServer.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await Promise.all([server, appServer].map(async (each) => { await new Promise<void>((resolve) => { each.close(() => { resolve() }) }) }))
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 90_000

interface Box { x: number, y: number, width: number, height: number }
interface Placed { url: string, bounds: Box }

async function launched (): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

/** The views in the window, with the address each shows and where it is. */
const layout = async (app: ElectronApplication): Promise<Placed[]> =>
  await app.evaluate(({ BaseWindow }) => {
    // Sorted by id, oldest first, never plain array order: a tab drag past
    // the split-model.ts's own edge share (window-actions.ts's
    // TAB_DRAG_SPLIT_SHARE) starts tear-drag.ts's floating preview, its own
    // BaseWindow, which getAllWindows() also lists -- created after, so
    // always a higher id, but not guaranteed to sort last in the array
    // itself (orivon-electron skill: match windows by URL/id, never by
    // array position).
    const [win] = [...BaseWindow.getAllWindows()].sort((a, b) => a.id - b.id)
    return (win?.contentView.children ?? []).flatMap((child) => {
      const contents = (child as unknown as { webContents?: { getURL: () => string } }).webContents
      return contents === undefined ? [] : [{ url: contents.getURL(), bounds: child.getBounds() }]
    })
  })

const inWindow = (views: Placed[], part: string): Box | undefined => views.find((view) => view.url.includes(part))?.bounds
const backdropAt = (views: Placed[]): Box | undefined => inWindow(views, '/split-frame/')

async function openTabs (chrome: Page, ...paths: string[]): Promise<string[]> {
  for (const path of paths) {
    await chrome.click('#new-tab')
    await clickAddressBarRetrying(chrome, `${origin}${path}`)
    expect((await waitForTab(chrome, { address: `${origin}${path}` })).ok).toBe(true)
  }
  return await tabIds(chrome)
}

/** Where a tab is. The strip is redrawn on every state push, so a box is asked for until one is there. */
async function boxOfTab (chrome: Page, id: string): Promise<Box> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const box = await chrome.locator(`.tab[data-id="${id}"]`).boundingBox({ timeout: 1000 }).catch(() => null)
    if (box !== null) return box
    await delay(100)
  }
  throw new Error(`the tab ${id} has no box`)
}

/** The size a pane's page lays itself out at, read from the page. A view put on screen without its renderer being told the pane's size keeps laying the page out at the size it had before, so the pane shows a clipped or empty page. */
async function layoutSizeOf (app: ElectronApplication, part: string): Promise<{ width: number, height: number } | undefined> {
  const page = app.windows().find((candidate) => candidate.url().includes(part))
  if (page === undefined) return undefined
  return await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
}

/** Whether each page in `parts` lays itself out at the size of its pane, the pane being where the window put its view. */
async function pagesFitTheirPanes (app: ElectronApplication, parts: readonly string[]): Promise<boolean> {
  const views = await layout(app)
  for (const part of parts) {
    const pane = inWindow(views, part)
    const size = await layoutSizeOf(app, part)
    if (pane === undefined || size === undefined || size.width !== pane.width || size.height !== pane.height) return false
  }
  return true
}

const runCommand = async (chrome: Page, id: string): Promise<void> => {
  await chrome.evaluate((command) => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand(command) }, id)
}
const activeId = async (chrome: Page): Promise<string | undefined> => await chrome.evaluate(() => document.querySelector<HTMLElement>('.tab.active')?.dataset['id'])
const joined = async (chrome: Page): Promise<string[]> => await chrome.evaluate(() => [...document.querySelectorAll<HTMLElement>('.tab.joined')].map((el) => el.dataset['id'] ?? ''))

it('shows two tabs side by side, each in its pane, with the divider between them', async () => {
  const { app, chrome } = await launched()
  try {
    const [, a] = await openTabs(chrome, '/a', '/b') as [string, string, string]
    // /b is the tab in front; join it with the one before it.
    await chrome.locator('.tab', { hasText: 'Page /a' }).click()
    expect(await waitFor(async () => await activeId(chrome) === a)).toBe(true)
    await runCommand(chrome, 'split.toggle')

    expect(await waitFor(async () => (await joined(chrome)).length === 2)).toBe(true)
    expect(await waitFor(async () => backdropAt(await layout(app)) !== undefined)).toBe(true)
    const views = await layout(app)
    const left = inWindow(views, `${origin}/a`)
    const right = inWindow(views, `${origin}/b`)
    const backdrop = backdropAt(views)
    if (left === undefined || right === undefined || backdrop === undefined) throw new Error('a pane or the backdrop is missing')
    expect(left.x + left.width).toBeLessThan(right.x)
    expect(left.y).toBe(right.y)
    expect(left.height).toBe(right.height)
    expect(Math.abs(left.width - right.width)).toBeLessThanOrEqual(1)
    // The backdrop is under the panes: it came first among the window's views.
    expect(views.findIndex((view) => view.url.includes('/split-frame/'))).toBeLessThan(views.findIndex((view) => view.url.includes(`${origin}/a`)))
    // The pane that joined sits above the one that was already there, in the order they read.
    expect(views.findIndex((view) => view.url.includes(`${origin}/a`))).toBeLessThan(views.findIndex((view) => view.url.includes(`${origin}/b`)))
    // The tab in front is the one the person was in.
    expect(await activeId(chrome)).toBe(a)
    expect(await chrome.locator('.tab.joined-first .title').textContent()).toBe('Page /a')
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('resizes with the divider, within limits, and goes back to half on a double click', async () => {
  const { app, chrome } = await launched()
  try {
    await openTabs(chrome, '/a')
    await runCommand(chrome, 'split.toggle')
    expect(await waitFor(async () => backdropAt(await layout(app)) !== undefined)).toBe(true)
    // The frame's view is Playwright's page only once its own session has attached, which can
    // come after the layout reports it.
    const frameOf = (): Page | undefined => app.windows().find((w) => w.url().includes('/split-frame/'))
    expect(await waitFor(() => frameOf() !== undefined)).toBe(true)
    const frame = frameOf() as Page
    await frame.waitForSelector('#divider:not([hidden])')
    await frame.locator('#divider').waitFor({ state: 'visible' })
    const divider = await frame.locator('#divider').boundingBox()
    if (divider === null) throw new Error('the divider has no box')
    const before = inWindow(await layout(app), origin)
    const startWidth = (await layout(app)).find((view) => view.url.includes(origin))?.bounds.width ?? 0

    await frame.mouse.move(divider.x + divider.width / 2, divider.y + 200)
    await frame.mouse.down()
    await frame.mouse.move(divider.x - 250, divider.y + 200, { steps: 8 })
    await frame.mouse.up()

    const widthAfter = async (): Promise<number> => ((await layout(app)).filter((view) => view.url.includes(origin)).sort((a, b) => a.bounds.x - b.bounds.x)[0]?.bounds.width ?? 0)
    expect(await waitFor(async () => await widthAfter() < startWidth - 150)).toBe(true)
    expect(before).toBeDefined()

    // As far as it can go, a pane is still a pane.
    await frame.mouse.move(divider.x + divider.width / 2 - 250, divider.y + 200)
    await frame.mouse.down()
    await frame.mouse.move(-500, divider.y + 200, { steps: 6 })
    await frame.mouse.up()
    expect(await waitFor(async () => await widthAfter() > 150)).toBe(true)

    await frame.locator('#divider').dblclick()
    expect(await waitFor(async () => Math.abs(await widthAfter() - startWidth) <= 1)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('makes the pane that is pressed the one the person is in, and closing one leaves the other full-size', async () => {
  const { app, chrome } = await launched()
  try {
    const [, a, b] = await openTabs(chrome, '/a', '/b') as [string, string, string]
    await chrome.locator('.tab', { hasText: 'Page /a' }).click()
    await runCommand(chrome, 'split.toggle')
    expect(await waitFor(async () => (await joined(chrome)).join() === [a, b].join())).toBe(true)
    expect(await waitFor(async () => backdropAt(await layout(app)) !== undefined)).toBe(true)
    expect(await activeId(chrome)).toBe(a)

    const pane = app.windows().find((w) => w.url() === `${origin}/b`) as Page
    await pane.mouse.click(100, 100)

    expect(await waitFor(async () => await activeId(chrome) === b)).toBe(true)
    expect((await layout(app)).filter((view) => view.url.includes('/split-frame/'))).toHaveLength(1)
    // Both panes stayed on screen: pressing one did not send the other away.
    expect((await layout(app)).filter((view) => view.url.includes(`${origin}/`))).toHaveLength(2)

    await runCommand(chrome, 'tab.close')
    expect(await waitFor(async () => (await joined(chrome)).length === 0)).toBe(true)
    expect(await waitFor(async () => backdropAt(await layout(app)) === undefined)).toBe(true)
    const rest = inWindow(await layout(app), `${origin}/a`)
    expect(rest?.width).toBeGreaterThan(1000)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('swaps the panes, goes to the other, stacks them, and breaks them up', async () => {
  const { app, chrome } = await launched()
  try {
    const [, a] = await openTabs(chrome, '/a') as [string, string]
    await chrome.locator('.tab', { hasText: 'Page /a' }).click()
    await runCommand(chrome, 'split.toggle')
    expect(await waitFor(async () => (await joined(chrome)).length === 2)).toBe(true)
    const [firstJoined] = await joined(chrome)

    await runCommand(chrome, 'split.swap')
    expect(await waitFor(async () => (await joined(chrome))[0] !== firstJoined)).toBe(true)

    await runCommand(chrome, 'split.focusOther')
    expect(await waitFor(async () => await activeId(chrome) !== a)).toBe(true)

    await runCommand(chrome, 'split.rotate')
    expect(await waitFor(async () => {
      const views = (await layout(app)).filter((view) => view.url.includes(origin) || view.url.includes('/newtab/'))
      return views.length === 2 && views[0]?.bounds.x === views[1]?.bounds.x && views[0]?.bounds.y !== views[1]?.bounds.y
    })).toBe(true)

    await runCommand(chrome, 'split.toggle')
    expect(await waitFor(async () => (await joined(chrome)).length === 0)).toBe(true)
    expect(await waitFor(async () => backdropAt(await layout(app)) === undefined)).toBe(true)
    expect(await tabIds(chrome)).toHaveLength(2)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('previews where a dragged tab would go over a page edge, and splits when it is let go there', async () => {
  const { app, chrome } = await launched()
  try {
    const [first, a] = await openTabs(chrome, '/a') as [string, string]
    // In front: /a. The dashboard tab is the one dragged.
    const area = await app.evaluate(({ BaseWindow }) => { const [win] = BaseWindow.getAllWindows(); const b = win?.getContentBounds(); return { width: b?.width ?? 0, height: b?.height ?? 0 } })

    await chrome.evaluate(([id, x, y]) => { (window as unknown as { orivonShell: { dragTab: (id: string, x: number, y: number) => void } }).orivonShell.dragTab(id as string, x as number, y as number) }, [first, 40, area.height / 2] as const)

    // /a shrinks to the right half; the backdrop marks the left one.
    expect(await waitFor(async () => {
      const views = await layout(app)
      const pane = inWindow(views, `${origin}/a`)
      return backdropAt(views) !== undefined && pane !== undefined && pane.x > area.width / 2 - 10 && pane.width < area.width / 2
    })).toBe(true)
    const frameOf = (): Page | undefined => app.windows().find((w) => w.url().includes('/split-frame/'))
    expect(await waitFor(() => frameOf() !== undefined)).toBe(true)
    const frame = frameOf() as Page
    await frame.waitForSelector('#placeholder:not([hidden])')

    // Back over the strip, the page is whole again.
    await chrome.evaluate((id) => { (window as unknown as { orivonShell: { dragTab: (id: string) => void } }).orivonShell.dragTab(id as string) }, first)
    expect(await waitFor(async () => backdropAt(await layout(app)) === undefined)).toBe(true)
    expect(inWindow(await layout(app), `${origin}/a`)?.width).toBeGreaterThan(area.width - 20)

    // Let go at the left edge: the dragged tab is the left pane.
    await app.evaluate(({ webContents }) => {
      const g = globalThis as unknown as { __focused: string[] }
      g.__focused = []
      for (const wc of webContents.getAllWebContents()) {
        const focus = wc.focus.bind(wc)
        wc.focus = () => { g.__focused.push(wc.getURL()); focus() }
      }
    })
    await chrome.evaluate(([id, x, y]) => { (window as unknown as { orivonShell: { dropTab: (id: string, sx: number, sy: number, cx: number, cy: number) => void } }).orivonShell.dropTab(id as string, x as number, y as number, x as number, y as number) }, [first, 40, area.height / 2] as const)
    expect(await waitFor(async () => (await joined(chrome)).join() === [first, a].join())).toBe(true)
    expect(await waitFor(async () => backdropAt(await layout(app)) !== undefined)).toBe(true)
    expect(await activeId(chrome)).toBe(first)
    // The pane dropped on the left sits straight below its partner in the window (nothing, the
    // chrome view included, between them), and the keyboard went into the dropped tab's page.
    const views = await layout(app)
    const dropped = views.findIndex((view) => view.url.includes('/newtab/'))
    expect(dropped).toBeGreaterThan(-1)
    expect(dropped).toBe(views.findIndex((view) => view.url.includes(`${origin}/a`)) - 1)
    expect(await waitFor(async () => (await app.evaluate(() => (globalThis as unknown as { __focused: string[] }).__focused)).at(-1)?.includes('/newtab/') === true)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('keeps two panes together when their tabs are moved along the strip', async () => {
  const { app, chrome } = await launched()
  try {
    const [first, a, b] = await openTabs(chrome, '/a', '/b') as [string, string, string]
    await chrome.locator('.tab', { hasText: 'Page /a' }).click()
    await runCommand(chrome, 'split.toggle')
    expect(await waitFor(async () => (await joined(chrome)).join() === [a, b].join())).toBe(true)

    await chrome.evaluate(([id]) => { (window as unknown as { orivonShell: { moveTab: (id: string, index: number) => void } }).orivonShell.moveTab(id as string, 0) }, [b] as const)

    expect(await waitFor(async () => (await tabIds(chrome)).join() === [a, b, first].join())).toBe(true)
    await delay(200)
    expect(await joined(chrome)).toEqual([a, b])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('splits when a tab is dragged with the pointer to the edge of the page and let go there', async () => {
  const { app, chrome } = await launched()
  try {
    const [first, a] = await openTabs(chrome, '/a') as [string, string]
    // /a is in front, and the dashboard tab is dragged: down onto the left edge of the page.
    const box = await boxOfTab(chrome, first)
    await chrome.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await chrome.mouse.down()
    await chrome.mouse.move(40, box.y + 300, { steps: 12 })
    // While it is held there, the page shows where it would go.
    expect(await waitFor(async () => backdropAt(await layout(app)) !== undefined)).toBe(true)
    await chrome.mouse.up()

    expect(await waitFor(async () => (await joined(chrome)).join() === [first, a].join())).toBe(true)
    expect(await activeId(chrome)).toBe(first)
    // Both pages are laid out at their half of the window, the dragged tab's included.
    expect(await waitFor(async () => await pagesFitTheirPanes(app, [`${origin}/a`, '/newtab/']))).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('splits from the right-click menu of a tab behind the one in front, and lays both pages out at their panes', async () => {
  const { app, chrome } = await launched()
  try {
    await app.evaluate(({ Menu }) => { (Menu.prototype as unknown as { popup: () => void }).popup = function (this: unknown) { (globalThis as unknown as { __menu: unknown }).__menu = this } })
    const [, a, b] = await openTabs(chrome, '/a', '/b') as [string, string, string]
    // /b is in front, and the menu is the one of /a behind it: the tab that is brought in is the one the person is in.
    expect(await activeId(chrome)).toBe(b)
    await chrome.click(`.tab[data-id="${a}"]`, { button: 'right' })
    expect(await waitFor(async () => await app.evaluate(() => (globalThis as unknown as { __menu?: unknown }).__menu !== undefined))).toBe(true)
    const partners = await app.evaluate(() => {
      const menu = (globalThis as unknown as { __menu: { items: Array<{ label: string, submenu?: { items: Array<{ label: string, click: () => void }> } }> } }).__menu
      const entries = menu.items.find((item) => item.label === 'Split with')?.submenu?.items ?? []
      entries.find((entry) => entry.label === 'Page /b')?.click()
      return entries.map((entry) => entry.label)
    })
    expect(partners).toContain('Page /b')

    expect(await waitFor(async () => (await joined(chrome)).join() === [a, b].join())).toBe(true)
    expect(await waitFor(async () => backdropAt(await layout(app)) !== undefined)).toBe(true)
    expect(await activeId(chrome)).toBe(b)
    const views = await layout(app)
    const left = inWindow(views, `${origin}/a`)
    const right = inWindow(views, `${origin}/b`)
    if (left === undefined || right === undefined) throw new Error('a pane is missing')
    expect(left.x + left.width).toBeLessThan(right.x)
    // The pane that was behind is attached by the split and the other is only resized: each page is laid out at its own pane.
    expect(await waitFor(async () => await pagesFitTheirPanes(app, [`${origin}/a`, `${origin}/b`]))).toBe(true)
    for (const part of [`${origin}/a`, `${origin}/b`]) {
      const page = app.windows().find((candidate) => candidate.url().includes(part))
      expect(await page?.evaluate(() => document.visibilityState)).toBe('visible')
    }
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

/** A picture of a page that is behind the one in front. Playwright asks the page for a frame it is not drawing, which keeps the page laid out at the size it had until its view is next told its size; the picture itself may never arrive, so the wait is short and its failure no matter. */
async function pictureOfHiddenPage (app: ElectronApplication, part: string): Promise<void> {
  const page = app.windows().find((candidate) => candidate.url().includes(part))
  if (page === undefined) throw new Error(`no page for ${part}`)
  await page.screenshot({ timeout: 1500 }).catch(() => undefined)
}

it('lays a page out at its pane when it was captured behind the one in front and is split in from the menu', async () => {
  const { app, chrome } = await launched()
  try {
    await app.evaluate(({ Menu }) => { (Menu.prototype as unknown as { popup: () => void }).popup = function (this: unknown) { (globalThis as unknown as { __menu: unknown }).__menu = this } })
    const [, a, b] = await openTabs(chrome, '/a', '/b') as [string, string, string]
    expect(await activeId(chrome)).toBe(b)
    await pictureOfHiddenPage(app, `${origin}/a`)
    await chrome.click(`.tab[data-id="${a}"]`, { button: 'right' })
    expect(await waitFor(async () => await app.evaluate(() => (globalThis as unknown as { __menu?: unknown }).__menu !== undefined))).toBe(true)
    await app.evaluate(() => {
      const menu = (globalThis as unknown as { __menu: { items: Array<{ label: string, submenu?: { items: Array<{ label: string, click: () => void }> } }> } }).__menu
      menu.items.find((item) => item.label === 'Split with')?.submenu?.items.find((entry) => entry.label === 'Page /b')?.click()
    })
    expect(await waitFor(async () => (await joined(chrome)).join() === [a, b].join())).toBe(true)
    expect(await waitFor(async () => await pagesFitTheirPanes(app, [`${origin}/a`, `${origin}/b`]), 8000)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('lays a page out at its pane when it was captured behind the one in front and is dragged to the edge of the page', async () => {
  const { app, chrome } = await launched()
  try {
    const [, a, b] = await openTabs(chrome, '/a', '/b') as [string, string, string]
    expect(await activeId(chrome)).toBe(b)
    await pictureOfHiddenPage(app, `${origin}/a`)
    const box = await boxOfTab(chrome, a)
    await chrome.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await chrome.mouse.down()
    await chrome.mouse.move(40, box.y + 300, { steps: 12 })
    expect(await waitFor(async () => backdropAt(await layout(app)) !== undefined)).toBe(true)
    await chrome.mouse.up()
    expect(await waitFor(async () => (await joined(chrome)).join() === [a, b].join())).toBe(true)
    expect(await waitFor(async () => await pagesFitTheirPanes(app, [`${origin}/a`, `${origin}/b`]), 8000)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

/** Where a view's page is painted: the colour of the pixel at the middle of a screenshot of it. */
async function paintedColour (pane: Page): Promise<number[]> {
  const png = PNG.sync.read(await pane.screenshot({ timeout: 5000 }))
  const at = (Math.floor(png.height / 2) * png.width + Math.floor(png.width / 2)) * 4
  return [png.data[at] ?? 0, png.data[at + 1] ?? 0, png.data[at + 2] ?? 0]
}

const SITE_RESOLVER = '--host-resolver-rules=MAP *.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'

it('keeps the pane that was split in laid out, in its place and painted through every kind of navigation', async () => {
  const app = await launchElectron({ appPath: '.', args: [SITE_RESOLVER] })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  const chrome = findChrome(app)
  try {
    const manifest: Manifest = { orivonApiVersion: 0, id: 'app.orivon.split-probe', name: 'split probe', version: '0.1.0', entry: 'index.html', capabilities: { net: { tcp: { connect: ['127.0.0.1:9'] } } } }
    const granted = await app.evaluate(async (_electron, request: DevGrantRequest) => {
      const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<unknown> }).__orivonDevGrant
      if (typeof hook !== 'function') return false
      await hook(request)
      return true
    }, { origin: appOrigin, manifest, capability: 'tcp.connect', patterns: ['127.0.0.1:9'] } satisfies DevGrantRequest)
    expect(granted).toBe(true)
    await app.evaluate(({ Menu }) => { (Menu.prototype as unknown as { popup: () => void }).popup = function (this: unknown) { (globalThis as unknown as { __menu: unknown }).__menu = this } })
    const [, a, b] = await openTabs(chrome, '/a', '/b') as [string, string, string]
    // A new tab keeps the page in front attached until its own page has drawn; the split starts once that is over.
    expect(await waitFor(async () => (await layout(app)).filter((view) => view.url.startsWith('http')).length === 1)).toBe(true)
    // /a is behind /b: it is the page the menu brings in, so its pane is the one that was split in.
    await chrome.click(`.tab[data-id="${a}"]`, { button: 'right' })
    expect(await waitFor(async () => await app.evaluate(() => (globalThis as unknown as { __menu?: unknown }).__menu !== undefined))).toBe(true)
    await app.evaluate(() => {
      const menu = (globalThis as unknown as { __menu: { items: Array<{ label: string, submenu?: { items: Array<{ label: string, click: () => void }> } }> } }).__menu
      menu.items.find((item) => item.label === 'Split with')?.submenu?.items.find((entry) => entry.label === 'Page /b')?.click()
    })
    expect(await waitFor(async () => (await joined(chrome)).join() === [a, b].join())).toBe(true)
    expect(await waitFor(async () => backdropAt(await layout(app)) !== undefined)).toBe(true)

    const site = (name: string): string => origin.replace('127.0.0.1', `${name}.test`)
    const leftPage = (part: string): Page | undefined => app.windows().find((candidate) => candidate.url().includes(part))
    const failures: string[] = []

    /** Waits for the left pane to show `part`, then reads everything the person sees of both panes. */
    const settled = async (step: string, part: string, rightPart: string): Promise<void> => {
      const shown = await waitFor(async () => {
        const views = await layout(app)
        return inWindow(views, part) !== undefined && inWindow(views, rightPart) !== undefined && await pagesFitTheirPanes(app, [part, rightPart])
      }, 12_000)
      const views = await layout(app)
      const pageViews = views.filter((view) => view.url.startsWith('http'))
      if (!shown) failures.push(`${step}: the panes ${part} and ${rightPart} are not both laid out at their bounds (${views.map((view) => `${view.url} ${JSON.stringify(view.bounds)}`).join('; ')})`)
      const frame = views.findIndex((view) => view.url.includes('/split-frame/'))
      if (frame !== 0) failures.push(`${step}: the backdrop is not the lowest view (index ${String(frame)})`)
      const byStack = pageViews.map((view) => view.bounds.x)
      if (byStack.length !== 2 || (byStack[0] ?? 0) > (byStack[1] ?? 0)) failures.push(`${step}: the panes are not stacked in the order they read: x ${byStack.join(', ')}`)
      for (const each of [part, rightPart]) {
        const view = leftPage(each)
        if (view === undefined) { failures.push(`${step}: no page for ${each}`); continue }
        const visibility = await view.evaluate(() => document.visibilityState).catch(() => 'unreadable')
        if (visibility !== 'visible') failures.push(`${step}: ${each} is ${visibility}`)
        const colour = await paintedColour(view).catch(() => [-1])
        if (colour.join() !== PAGE_GREEN.join()) failures.push(`${step}: ${each} paints ${colour.join()}, not its page`)
      }
    }

    // The pane that was split in is the one the person works in.
    await leftPage(`${origin}/a`)?.mouse.click(120, 200)
    expect(await waitFor(async () => await activeId(chrome) === a)).toBe(true)
    await settled('after the split', `${origin}/a`, `${origin}/b`)

    await clickAddressBarRetrying(chrome, `${origin}/c1`)
    await settled('address bar, same site', `${origin}/c1`, `${origin}/b`)

    await leftPage(`${origin}/c1`)?.click('#go')
    await settled('link, same site', `${origin}/c1-link`, `${origin}/b`)

    await leftPage(`${origin}/c1-link`)?.evaluate((target) => { location.href = target }, `${origin}/c2`)
    await settled('script, same site', `${origin}/c2`, `${origin}/b`)

    await clickAddressBarRetrying(chrome, `${site('two')}/c3`)
    await settled('address bar, another site', `${site('two')}/c3`, `${origin}/b`)

    await leftPage(`${site('two')}/c3`)?.evaluate((target) => { location.href = target }, `${site('three')}/c4`)
    await settled('script, another site', `${site('three')}/c4`, `${origin}/b`)

    await clickAddressBarRetrying(chrome, `${appOrigin}/c5`)
    await settled('address bar, into an app', `${appOrigin}/c5`, `${origin}/b`)

    await leftPage(`${appOrigin}/c5`)?.evaluate((target) => { location.href = target }, `${origin}/c6`)
    await settled('script, out of an app', `${origin}/c6`, `${origin}/b`)

    await leftPage(`${origin}/c6`)?.evaluate((target) => { location.href = target }, `${appOrigin}/c7`)
    await settled('script, into an app', `${appOrigin}/c7`, `${origin}/b`)

    // The other pane gets the same: one press makes it the pane the person is in.
    await leftPage(`${origin}/b`)?.mouse.click(120, 200)
    expect(await waitFor(async () => await activeId(chrome) === b)).toBe(true)
    await clickAddressBarRetrying(chrome, `${appOrigin}/d1`)
    await settled('the other pane, into an app', `${appOrigin}/c7`, `${appOrigin}/d1`)
    await leftPage(`${appOrigin}/d1`)?.evaluate((target) => { location.href = target }, `${origin}/d2`)
    await settled('the other pane, out of an app', `${appOrigin}/c7`, `${origin}/d2`)

    // An address of the shell's own opens its page in a tab of its own, which takes the screen from the pair; the pair comes back whole.
    await clickAddressBarRetrying(chrome, 'orivon://settings')
    expect(await waitFor(async () => (await layout(app)).every((view) => !view.url.includes(`${origin}/`) && !view.url.includes('/split-frame/')))).toBe(true)
    await chrome.click(`.tab[data-id="${a}"]`)
    await settled('back from an internal page', `${appOrigin}/c7`, `${origin}/d2`)

    expect(failures).toEqual([])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, 240_000)
