// Split view in the running shell: two tabs side by side or stacked, each in
// its pane, with a divider that resizes, a pane that is the one the person is in,
// and the gestures that make and unmake one. Read off the real window: which
// views are in it, and where.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from './launch-electron.mjs'
import { clickAddressBarRetrying } from './e2e-helpers.js'
import { delay, findChrome, HERMETIC_RESOLVER, tabIds, waitFor, waitForTab } from './smoke-helpers.mjs'

let server: Server
let origin = ''

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end(`<!doctype html><title>Page ${request.url ?? ''}</title><body style="margin:0;height:100vh"><p>${request.url ?? ''}</p></body>`)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
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
    const [win] = BaseWindow.getAllWindows()
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
    const frame = app.windows().find((w) => w.url().includes('/split-frame/')) as Page
    await frame.waitForSelector('#divider:not([hidden])')
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
    const frame = app.windows().find((w) => w.url().includes('/split-frame/')) as Page
    await frame.waitForSelector('#placeholder:not([hidden])')

    // Back over the strip, the page is whole again.
    await chrome.evaluate((id) => { (window as unknown as { orivonShell: { dragTab: (id: string) => void } }).orivonShell.dragTab(id as string) }, first)
    expect(await waitFor(async () => backdropAt(await layout(app)) === undefined)).toBe(true)
    expect(inWindow(await layout(app), `${origin}/a`)?.width).toBeGreaterThan(area.width - 20)

    // Let go at the left edge: the dragged tab is the left pane.
    await chrome.evaluate(([id, x, y]) => { (window as unknown as { orivonShell: { dropTab: (id: string, sx: number, sy: number, cx: number, cy: number) => void } }).orivonShell.dropTab(id as string, x as number, y as number, x as number, y as number) }, [first, 40, area.height / 2] as const)
    expect(await waitFor(async () => (await joined(chrome)).join() === [first, a].join())).toBe(true)
    expect(await waitFor(async () => backdropAt(await layout(app)) !== undefined)).toBe(true)
    expect(await activeId(chrome)).toBe(first)
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
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
