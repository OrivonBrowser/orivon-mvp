// The link bubble, in the running shell: pointing at a link, or moving the keyboard onto one, shows where it goes in
// the bottom-left corner of the page that link is in, one line wide as its text; it moves to the bottom-right corner
// when the pointer reaches it; it never takes the keyboard, lies under an open menu, and goes with its tab. The
// pointer is Playwright's, sent to the page under it and to the bubble's own page, the way a pointer moving between
// the two views reaches each.
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { html, launchShell, startServer, visit } from '../support/qa-helpers.js'
import type { FixtureServer } from '../support/qa-helpers.js'
import { ABSENCE_SETTLE_MS, delay, findViewShowing, popoverShown, tabIds, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

const TEST_TIMEOUT_MS = 90_000
const LONG_PATH = `/${'long-segment/'.repeat(80)}`

let server: FixtureServer

/** Every page has the same links, in places a spec can point at. */
const PAGE = (name: string): string => `<!doctype html><title>${name}</title>
<body style="margin:0;height:100vh;font:16px sans-serif">
<a id="top" href="/${name}/top-link" style="position:fixed;left:300px;top:100px">top link</a>
<a id="other" href="/${name}/other-link" style="position:fixed;left:300px;top:200px">other link</a>
<a id="long" href="${LONG_PATH}" style="position:fixed;left:300px;top:300px">long link</a>
<a id="corner" href="/${name}/corner-link" style="position:fixed;left:0;bottom:0;width:260px;height:80px;background:#cde">corner</a>
<input id="field" style="position:fixed;left:300px;top:400px">
</body>`

beforeAll(async () => {
  server = await startServer((request, response) => {
    const name = (request.url ?? '/').split('/')[1] ?? ''
    html(response, PAGE(name === '' ? 'home' : name))
  })
})

afterAll(async () => {
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface Box { x: number, y: number, width: number, height: number }
interface BubbleView { id: number, visible: boolean, bounds: Box, index: number }

/** The bubble's view among the window's children, or nothing while none was ever made. */
async function bubbleView (app: ElectronApplication): Promise<BubbleView | null> {
  return await app.evaluate(({ BaseWindow }) => {
    const [win] = [...BaseWindow.getAllWindows()].sort((a, b) => a.id - b.id)
    const children = win?.contentView.children ?? []
    const view = children.find((child) => (child as unknown as { webContents?: { getURL: () => string } }).webContents?.getURL().includes('overlay=link-status') === true)
    if (view === undefined) return null
    return { id: (view as unknown as { webContents: { id: number } }).webContents.id, visible: view.getVisible(), bounds: view.getBounds(), index: children.indexOf(view) }
  })
}

/** Where a tab's page is in the window: its view's rectangle. */
async function paneOf (app: ElectronApplication, url: string): Promise<Box> {
  const pane = await app.evaluate(({ BaseWindow }, address) => {
    const [win] = [...BaseWindow.getAllWindows()].sort((a, b) => a.id - b.id)
    return win?.contentView.children.find((child) => (child as unknown as { webContents?: { getURL: () => string } }).webContents?.getURL() === address)?.getBounds()
  }, url)
  if (pane === undefined) throw new Error(`no view shows ${url}`)
  return pane
}

const bubblePage = (app: ElectronApplication): Page | undefined => app.windows().find((page) => page.url().includes('overlay=link-status'))

interface Shown { text: string, rect: Box, view: BubbleView }

/** What the person sees: the text and the rectangle of the bubble, in window pixels, or nothing while it is not up. */
async function shown (app: ElectronApplication): Promise<Shown | undefined> {
  const view = await bubbleView(app)
  const page = bubblePage(app)
  if (view === null || !view.visible || view.bounds.width === 0 || view.bounds.height === 0 || page === undefined) return undefined
  const drawn = await page.evaluate(() => {
    const element = document.querySelector('.link-status:not(.link-status-probe)')
    if (element === null) return null
    const box = element.getBoundingClientRect()
    return { text: element.textContent ?? '', x: box.x, y: box.y, width: box.width, height: box.height }
  }).catch(() => null)
  if (drawn === null || drawn.text === '') return undefined
  return { text: drawn.text, rect: { x: view.bounds.x + drawn.x, y: view.bounds.y + drawn.y, width: drawn.width, height: drawn.height }, view }
}

async function bubbleSays (app: ElectronApplication, text: string): Promise<boolean> {
  const bubble = await shown(app)
  return bubble?.text === text
}

async function bubbleUp (app: ElectronApplication, text: string): Promise<Shown> {
  expect(await waitFor(async () => await bubbleSays(app, text))).toBe(true)
  return await shown(app) as Shown
}

/** The bubble has gone and is not ever coming back by itself: its view is still in the window, hidden. */
async function expectGone (app: ElectronApplication): Promise<void> {
  expect(await waitFor(async () => (await shown(app)) === undefined)).toBe(true)
  const view = await bubbleView(app)
  expect(view?.visible).toBe(false)
}

const bottom = (box: Box): number => box.y + box.height
const right = (box: Box): number => box.x + box.width

/** The window as the owner uses it: maximized first, then a page loaded, then the pointer on a link. */
async function launchMaximized (): Promise<{ app: ElectronApplication, chrome: Page, tab: Page, url: string }> {
  const { app, chrome } = await launchShell({ env: { PULSE_SERVER: 'unix:/nonexistent' }, args: ['--alsa-output-device=null'] })
  await app.evaluate(({ BaseWindow }) => { BaseWindow.getAllWindows()[0]?.maximize() })
  await delay(600)
  const url = `${server.origin}/one`
  const tab = await visit(app, chrome, url)
  return { app, chrome, tab, url }
}

/** Records every change of the bubble's view (shown or not, where, how wide) from inside the main process, so a flicker between two polls is still seen. */
async function startRecording (app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BaseWindow }) => {
    const samples: Array<{ visible: boolean, x: number, width: number }> = []
    let last = ''
    const timer = setInterval(() => {
      const [win] = [...BaseWindow.getAllWindows()].sort((a, b) => a.id - b.id)
      const view = win?.contentView.children.find((child) => (child as unknown as { webContents?: { getURL: () => string } }).webContents?.getURL().includes('overlay=link-status') === true)
      if (view === undefined) return
      const bounds = view.getBounds()
      const now = `${String(view.getVisible())}|${String(bounds.x)}|${String(bounds.width)}`
      if (now === last) return
      last = now
      samples.push({ visible: view.getVisible(), x: bounds.x, width: bounds.width })
    }, 4)
    Object.assign(globalThis, { __linkStatusSamples: samples, __linkStatusTimer: timer })
  })
}

async function stopRecording (app: ElectronApplication): Promise<Array<{ visible: boolean, x: number, width: number }>> {
  return await app.evaluate(() => {
    const g = globalThis as unknown as { __linkStatusSamples: Array<{ visible: boolean, x: number, width: number }>, __linkStatusTimer: ReturnType<typeof setInterval> }
    clearInterval(g.__linkStatusTimer)
    return g.__linkStatusSamples
  })
}

it('shows nothing, and builds nothing, until a link is pointed at', async () => {
  const { app } = await launchMaximized()
  try {
    await delay(ABSENCE_SETTLE_MS)
    expect(await bubbleView(app)).toBeNull()
    expect(bubblePage(app)).toBeUndefined()
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('says where a hovered link goes in the bottom-left corner of its page, as wide as the text, and goes when the pointer leaves', async () => {
  const { app, tab, url } = await launchMaximized()
  try {
    await tab.hover('#top')
    const up = await bubbleUp(app, `${server.origin}/one/top-link`)
    const pane = await paneOf(app, url)

    expect(up.rect.x).toBe(pane.x)
    expect(Math.abs(bottom(up.rect) - bottom(pane))).toBeLessThanOrEqual(1)
    expect(up.rect.height).toBeGreaterThanOrEqual(24)
    expect(up.rect.height).toBeLessThanOrEqual(26)
    // As wide as what it says: the page's own measurement of the text, not a strip.
    const probe = await (bubblePage(app) as Page).evaluate(() => document.querySelector('.link-status-probe')?.getBoundingClientRect().width ?? 0)
    expect(Math.abs(up.rect.width - probe)).toBeLessThanOrEqual(1)
    expect(up.rect.width).toBeLessThan(pane.width / 2)
    // The view is as big as what shows and the hidden corners, never a strip over the page.
    expect(up.view.bounds.width).toBeLessThan(up.rect.width + 20)
    expect(up.view.bounds.height).toBeLessThan(40)

    await tab.mouse.move(pane.width - 80, 300)
    await expectGone(app)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('keeps one view, hidden in the window between links, across many links', async () => {
  const { app, tab } = await launchMaximized()
  try {
    await tab.hover('#top')
    const first = await bubbleUp(app, `${server.origin}/one/top-link`)

    // Link to link: the same bubble, the text swapped in place.
    await startRecording(app)
    await tab.hover('#other')
    await bubbleUp(app, `${server.origin}/one/other-link`)
    await delay(300)
    const samples = await stopRecording(app)
    expect(samples.filter((sample) => !sample.visible)).toEqual([])

    for (let again = 0; again < 3; again += 1) {
      await tab.mouse.move(900, 600)
      await expectGone(app)
      await tab.hover('#top')
      const up = await bubbleUp(app, `${server.origin}/one/top-link`)
      expect(up.view.id).toBe(first.view.id)
    }
    // The count of views never grew, and the hidden one is a child of the window still.
    const count = await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((wc) => wc.getURL().includes('overlay=link-status')).length)
    expect(count).toBe(1)
    await tab.mouse.move(900, 600)
    await expectGone(app)
    expect(await bubbleView(app)).toMatchObject({ id: first.view.id, visible: false })
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('cuts a long address with an ellipsis inside a bubble of at most 600 pixels and half the page', async () => {
  const { app, tab, url } = await launchMaximized()
  try {
    await tab.hover('#long')
    const up = await bubbleUp(app, `${server.origin}${LONG_PATH}`.slice(0, 1024))
    const pane = await paneOf(app, url)
    expect(up.rect.width).toBeLessThanOrEqual(600)
    expect(up.rect.width).toBeLessThanOrEqual(pane.width / 2)
    const clipped = await (bubblePage(app) as Page).evaluate(() => {
      const element = document.querySelector('.link-status:not(.link-status-probe)') as HTMLElement
      return { overflow: element.scrollWidth > element.clientWidth, ellipsis: getComputedStyle(element).textOverflow }
    })
    expect(clipped).toEqual({ overflow: true, ellipsis: 'ellipsis' })
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('moves to the bottom-right corner when the pointer reaches it, and ends steadily there', async () => {
  const { app, tab, url } = await launchMaximized()
  try {
    const pane = await paneOf(app, url)
    // A link in the corner the bubble takes, pointed at near its bottom edge: the bubble covers the pointer.
    await tab.hover('#corner', { position: { x: 10, y: 70 } })
    const onLeft = await bubbleUp(app, `${server.origin}/one/corner-link`)
    expect(onLeft.rect.x).toBe(pane.x)

    await startRecording(app)
    // The pointer enters the bubble; the tab's page loses the link and has it again once the bubble has moved.
    const bubble = bubblePage(app) as Page
    await bubble.mouse.move(onLeft.rect.x + 20 - (onLeft.view.bounds.x), onLeft.rect.y + 12 - onLeft.view.bounds.y)
    await Promise.all([tab.mouse.move(pane.width - 100, 300), tab.mouse.move(10, pane.height - 10)])

    expect(await waitFor(async () => {
      const now = await shown(app)
      return now !== undefined && Math.abs(right(now.rect) - right(pane)) <= 1
    })).toBe(true)
    await delay(ABSENCE_SETTLE_MS)
    const settled = await shown(app) as Shown
    expect(settled.text).toBe(`${server.origin}/one/corner-link`)
    expect(Math.abs(right(settled.rect) - right(pane))).toBeLessThanOrEqual(1)
    expect(Math.abs(bottom(settled.rect) - bottom(pane))).toBeLessThanOrEqual(1)

    // No hide and no return to the left on the way: it moved once and stayed.
    const samples = (await stopRecording(app)).filter((sample) => sample.width > 0)
    expect(samples.filter((sample) => !sample.visible)).toEqual([])
    const sides = samples.map((sample) => sample.x < pane.width / 2 ? 'left' : 'right')
    expect(sides.filter((side, index) => index > 0 && side !== sides[index - 1])).toEqual(['right'])

    // Another link while it is on the right stays on the right; once it has hidden, the next one starts on the left.
    await tab.hover('#top')
    const next = await bubbleUp(app, `${server.origin}/one/top-link`)
    expect(Math.abs(right(next.rect) - right(pane))).toBeLessThanOrEqual(1)
    await tab.mouse.move(pane.width - 80, 300)
    await expectGone(app)
    await tab.hover('#top')
    expect((await bubbleUp(app, `${server.origin}/one/top-link`)).rect.x).toBe(pane.x)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('shows for a link the keyboard reaches, too', async () => {
  const { app, tab } = await launchMaximized()
  try {
    await tab.focus('#field')
    await tab.keyboard.press('Shift+Tab')
    // The keyboard is on the last link before the field.
    const up = await bubbleUp(app, `${server.origin}/one/corner-link`)
    expect(up.rect.width).toBeGreaterThan(0)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('goes at once with a tab switch and with the navigation of its tab, and is not shown for a tab that is behind', async () => {
  const { app, chrome, tab, url } = await launchMaximized()
  try {
    await tab.hover('#top')
    await bubbleUp(app, `${server.origin}/one/top-link`)
    await chrome.click('#new-tab')
    expect(await waitFor(async () => (await tabIds(chrome)).length === 2)).toBe(true)
    await expectGone(app)

    // Back on the first tab, a click on the link navigates it away: the bubble is gone with the page, before the delay would end it.
    await chrome.locator('.tab', { hasText: 'one' }).click()
    expect(await waitFor(async () => findViewShowing(app, chrome, url) !== undefined)).toBe(true)
    const first = findViewShowing(app, chrome, url) as Page
    await first.hover('#top')
    await bubbleUp(app, `${server.origin}/one/top-link`)
    await first.click('#top')
    expect(await waitFor(async () => (await shown(app)) === undefined, 400)).toBe(true)
    expect((await waitForTab(chrome, { address: `${server.origin}/one/top-link` })).ok).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('does not close an open menu, lies under it, and leaves the keyboard in the page\'s field', async () => {
  const { app, chrome, tab } = await launchMaximized()
  try {
    await tab.click('#field')
    await chrome.click('#menu')
    expect(await waitFor(async () => await popoverShown(app, 'overlay=menu'))).toBe(true)
    const focusedBefore = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((wc) => wc.isFocused())?.id)

    await tab.hover('#top')
    await bubbleUp(app, `${server.origin}/one/top-link`)
    await delay(ABSENCE_SETTLE_MS)

    expect(await popoverShown(app, 'overlay=menu')).toBe(true)
    const menuIndex = await app.evaluate(({ BaseWindow }) => {
      const children = BaseWindow.getAllWindows()[0]?.contentView.children ?? []
      return children.findIndex((child) => (child as unknown as { webContents?: { getURL: () => string } }).webContents?.getURL().includes('overlay=menu') === true)
    })
    expect(menuIndex).toBeGreaterThan((await bubbleView(app))?.index ?? Number.POSITIVE_INFINITY)
    // The keyboard is where it was: in the page's field, never in the bubble.
    expect(await tab.evaluate(() => document.activeElement?.id)).toBe('field')
    expect(await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((wc) => wc.isFocused())?.id)).toBe(focusedBefore)
    expect(await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((wc) => wc.getURL().includes('overlay=link-status'))?.isFocused())).toBe(false)

    // The menu closes as it always did, and the bubble still works after it.
    await (app.windows().find((page) => page.url().includes('overlay=menu')) as Page).keyboard.press('Escape')
    expect(await waitFor(async () => !(await popoverShown(app, 'overlay=menu')))).toBe(true)
    await tab.hover('#other')
    await bubbleUp(app, `${server.origin}/one/other-link`)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('is in the corner of the pane the pointer is in, in a split window, not of the pane in front', async () => {
  const { app, chrome } = await launchMaximized()
  try {
    await chrome.click('#new-tab')
    await clickAddressBarRetrying(chrome, `${server.origin}/two`)
    expect((await waitForTab(chrome, { address: `${server.origin}/two` })).ok).toBe(true)
    await chrome.locator('.tab', { hasText: 'one' }).click()
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand('split.toggle') })
    const panes = async (): Promise<[Box, Box]> => [await paneOf(app, `${server.origin}/one`), await paneOf(app, `${server.origin}/two`)]
    expect(await waitFor(async () => {
      try {
        const [a, b] = await panes()
        return a.width < 1000 && b.width < 1000 && a.x !== b.x
      } catch { return false }
    })).toBe(true)
    const [one, two] = await panes()
    expect(two.x).toBeGreaterThan(one.x)
    expect(await waitFor(() => findViewShowing(app, chrome, `${server.origin}/two`) !== undefined && findViewShowing(app, chrome, `${server.origin}/one`) !== undefined)).toBe(true)
    const pageOne = findViewShowing(app, chrome, `${server.origin}/one`) as Page
    const pageTwo = findViewShowing(app, chrome, `${server.origin}/two`) as Page

    // The tab in front is the first; the pointer is in the second.
    await pageTwo.hover('#top')
    const inTwo = await bubbleUp(app, `${server.origin}/two/top-link`)
    expect(inTwo.rect.x).toBe(two.x)
    expect(Math.abs(bottom(inTwo.rect) - bottom(two))).toBeLessThanOrEqual(1)

    await pageOne.hover('#top')
    const inOne = await bubbleUp(app, `${server.origin}/one/top-link`)
    expect(inOne.rect.x).toBe(one.x)
    expect(Math.abs(bottom(inOne.rect) - bottom(one))).toBeLessThanOrEqual(1)
    expect(right(inOne.rect)).toBeLessThanOrEqual(one.x + one.width)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
