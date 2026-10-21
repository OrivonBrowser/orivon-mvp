// The shell stays alive when the window is maximized before the first `.eth` page loads. The flow: a tab is
// loading (a server that never answers), the window is maximized, the first `.eth` name opens, then the Menu and a
// question are opened and closed. After the first page, and after every overlay closes, the chrome must still
// animate, take a click, and have views that fill the window at its new size.
//
// What it can and cannot see. Playwright's debugger makes every page report itself visible, so a view left hidden by a
// removal reads `visible` here (src/main/overlays/README.md section A warm view is hidden in place); this spec therefore
// pins the window tree (each view a visible child of the window, sized to it, its page laid out at that size) and the
// chrome's own frames and animation, which a frozen chrome stops. A real window manager's maximize runs on the
// Windows and macOS runners (`node scripts/ci/cross-os.mjs --specs test/window/e2e-maximized-first.test.ts`); under
// the headless display no window manager honours it, so the window is resized to a larger size instead, which is the
// same resize path.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron } from '../support/launch-electron.mjs'
import { focusWebContents, underVirtualDisplay } from '../support/focus-helpers.js'
import { answerQuestion, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import { delay, findChrome, popoverShown, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

const TEST_TIMEOUT_MS = 120_000
const DAY_MS = 86_400_000
const ETH_NAME = 'maximizedfirst.eth'
const ETH_URL = `http://${ETH_NAME}/`
const ETH_TITLE = 'Maximized first fixture'
/** What the window is made before it is maximized. */
const SMALL_SIZE = { width: 600, height: 440 }
/** The resize used where no window manager maximizes: larger than SMALL_SIZE on every display. */
const FALLBACK_SIZE = { width: 1500, height: 950 }

let ethServer: Server
let hangServer: Server
let namesDir = ''
let namesFile = ''
let hangUrl = ''

beforeAll(async () => {
  ethServer = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end(`<!doctype html><title>${ETH_TITLE}</title><body style="font:16px sans-serif"><h1>${ETH_TITLE}</h1></body>`)
  })
  await new Promise<void>((resolve) => { ethServer.listen(0, '127.0.0.1', resolve) })
  // Never answers: its tab keeps its loading indicator for the whole spec.
  hangServer = createServer(() => {})
  await new Promise<void>((resolve) => { hangServer.listen(0, '127.0.0.1', resolve) })
  hangUrl = `http://127.0.0.1:${String((hangServer.address() as AddressInfo).port)}/slow`
  namesDir = mkdtempSync(join(tmpdir(), 'orivon-maxfirst-'))
  namesFile = join(namesDir, 'names.json')
  writeFileSync(namesFile, JSON.stringify({ [ETH_NAME]: (ethServer.address() as AddressInfo).port }))
})

afterAll(async () => {
  hangServer.closeAllConnections()
  await Promise.all([ethServer, hangServer].map(async (server) => await new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
  rmSync(namesDir, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface LayoutView { url: string, visible: boolean, bounds: { x: number, y: number, width: number, height: number }, inner: [number, number] | null }
interface Layout { content: { width: number, height: number }, views: LayoutView[] }

/** The window's content size and each child view: where it is, whether it is shown, and the size its page lays out at. */
async function layoutOf (app: ElectronApplication): Promise<Layout> {
  return await app.evaluate(async ({ BaseWindow }) => {
    const win = BaseWindow.getAllWindows()[0]
    if (win === undefined) throw new Error('no window')
    const { width, height } = win.getContentBounds()
    const views: LayoutView[] = []
    for (const child of win.contentView.children) {
      const contents = (child as unknown as { webContents?: Electron.WebContents }).webContents
      if (contents === undefined || contents.isDestroyed()) continue
      const visible = child.getVisible()
      const inner = visible
        ? await Promise.race([
          contents.executeJavaScript('[innerWidth, innerHeight]') as Promise<[number, number]>,
          new Promise<null>((resolve) => { setTimeout(() => { resolve(null) }, 3_000) })
        ]).catch(() => null)
        : null
      views.push({ url: contents.getURL(), visible, bounds: child.getBounds(), inner })
    }
    return { content: { width, height }, views }
  })
}

/** What a window of this size must look like: the chrome across the top, the tab below it, every shown chrome or tab page laid out at its view's size. */
function expectFilled (layout: Layout, label: string): void {
  const { content, views } = layout
  const chrome = views.find((view) => view.url.endsWith('/renderer/index.html'))
  const tab = views.find((view) => view.url === ETH_URL)
  expect({ label, chrome: chrome === undefined ? 'missing' : { visible: chrome.visible, x: chrome.bounds.x, y: chrome.bounds.y, width: chrome.bounds.width } })
    .toEqual({ label, chrome: { visible: true, x: 0, y: 0, width: content.width } })
  expect({ label, tab: tab === undefined ? 'missing' : { visible: tab.visible, x: tab.bounds.x, width: tab.bounds.width, bottom: tab.bounds.y + tab.bounds.height } })
    .toEqual({ label, tab: { visible: true, x: 0, width: content.width, bottom: content.height } })
  // A popup sizes itself to its content, a moment after it is shown: only the chrome and the tabs follow the window.
  for (const view of views.filter((entry) => entry.visible && !entry.url.includes('/overlay/'))) {
    const [innerWidth, innerHeight] = view.inner ?? [-1, -1]
    expect({ label, url: view.url, laidOutAtItsSize: Math.abs(innerWidth - view.bounds.width) <= 1 && Math.abs(innerHeight - view.bounds.height) <= 1 })
      .toEqual({ label, url: view.url, laidOutAtItsSize: true })
  }
}

interface Progress { frames: number, animated: number, running: number, loadingTabs: number }

/** Frames the chrome page draws in a second, and how far its running animations (the loading indicator) moved in it, in milliseconds. */
async function chromeProgress (chrome: Page): Promise<Progress> {
  return await chrome.evaluate(async () => {
    const running = document.getAnimations().filter((animation) => animation.playState === 'running')
    const before = running.map((animation) => Number(animation.currentTime ?? 0))
    const start = performance.now()
    let frames = 0
    await new Promise<void>((resolve) => {
      const tick = (): void => {
        frames += 1
        if (performance.now() - start < 1_000) requestAnimationFrame(tick)
        else resolve()
      }
      requestAnimationFrame(tick)
    })
    const moved = running.map((animation, index) => Number(animation.currentTime ?? 0) - (before[index] ?? 0))
    return { frames, animated: Math.max(0, ...moved), running: running.length, loadingTabs: document.querySelectorAll('.tab .fav.loading').length }
  })
}

// A second is measured, so the floors are far below what a healthy chrome does (tens of frames, the animation's own
// second) and far above what a frozen one does (none).
const MIN_FRAMES = 5
const MIN_ANIMATED_MS = 500

async function expectAlive (app: ElectronApplication, chrome: Page, label: string): Promise<void> {
  const progress = await chromeProgress(chrome)
  expect({ label, progress, drawing: progress.frames >= MIN_FRAMES, loadingIndicatorMoves: progress.animated >= MIN_ANIMATED_MS }).toEqual({ label, progress, drawing: true, loadingIndicatorMoves: true })
  expectFilled(await layoutOf(app), label)
}

async function openMenu (app: ElectronApplication, chrome: Page): Promise<void> {
  // Past the debounce that reads a click just after a close as that close's echo.
  await delay(450)
  await chrome.click('#menu')
  expect(await waitFor(async () => await popoverShown(app, 'overlay=menu'))).toBe(true)
}

async function menuClosed (app: ElectronApplication): Promise<void> {
  expect(await waitFor(async () => !(await popoverShown(app, 'overlay=menu')))).toBe(true)
}

/** Maximizes the window, or, where no window manager acts on it, resizes it larger; returns the content width before and after. */
async function maximize (app: ElectronApplication): Promise<{ before: number, after: number }> {
  // A window smaller than any display, so maximizing it changes its size on every runner.
  await app.evaluate(({ BaseWindow }, size) => { BaseWindow.getAllWindows()[0]?.setBounds({ x: 20, y: 20, ...size }) }, SMALL_SIZE)
  expect(await waitFor(async () => (await layoutOf(app)).content.width <= SMALL_SIZE.width)).toBe(true)
  await delay(500)
  const before = (await layoutOf(app)).content.width
  await app.evaluate(({ BaseWindow }, size) => {
    const win = BaseWindow.getAllWindows()[0]
    win?.maximize()
    // A window manager answers within a moment; with none, the window keeps its size and is resized instead.
    setTimeout(() => { if (win !== undefined && !win.isDestroyed() && !win.isMaximized()) win.setBounds({ x: 0, y: 0, ...size }) }, 1_500)
  }, FALLBACK_SIZE)
  await delay(2_000)
  expect(await waitFor(async () => (await layoutOf(app)).content.width > before)).toBe(true)
  // Settled: the views have followed the window to its final size.
  expect(await waitFor(async () => {
    const layout = await layoutOf(app)
    const chrome = layout.views.find((view) => view.url.endsWith('/renderer/index.html'))
    return chrome?.bounds.width === layout.content.width
  })).toBe(true)
  return { before, after: (await layoutOf(app)).content.width }
}

it('keeps the chrome drawing, laid out and clickable after maximizing before the first .eth page, and after the Menu and a question open and close', async () => {
  const startedAt = Date.now()
  const app = await launchElectron({
    appPath: '.',
    env: { ORIVON_DEV_ORIGINS: '1', ORIVON_ETH_NAMES_FILE: namesFile, ORIVON_TEST_DEFAULT_BROWSER: 'can-set' },
    freshDefaultBrowserAsk: true,
    seedProfile: (dir: string) => {
      // Due now, so the question can be raised on demand below.
      writeFileSync(join(dir, 'default-browser-ask.json'), JSON.stringify({ firstSeenAt: startedAt - 15 * DAY_MS, lastAskedAt: startedAt - 8 * DAY_MS, stopped: false }))
    }
  })
  try {
    expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
    const chrome = findChrome(app)
    await chrome.waitForFunction(() => document.readyState === 'complete')
    await stubNativeDialogs(app)

    // A tab that is still loading: the indicator the rest of the spec watches.
    await chrome.evaluate((url: string) => { (window as unknown as { orivonShell: { newTab: (target: string) => void } }).orivonShell.newTab(url) }, hangUrl)
    expect(await waitFor(async () => await chrome.evaluate(() => document.querySelector('.tab .fav.loading') !== null))).toBe(true)

    const { before, after } = await maximize(app)
    expect(after).toBeGreaterThan(before)

    // The first .eth page of the session, opened with the window already at its new size.
    await chrome.evaluate((url: string) => { (window as unknown as { orivonShell: { newTab: (target: string) => void } }).orivonShell.newTab(url) }, ETH_URL)
    expect((await waitForTab(chrome, { address: ETH_URL, title: ETH_TITLE })).ok).toBe(true)
    await expectAlive(app, chrome, 'after the first .eth page')

    // The Menu, closed the way a person closes it: a click into the page.
    await openMenu(app, chrome)
    expectFilled(await layoutOf(app), 'menu open')
    await focusWebContents(app, ETH_URL)
    await menuClosed(app)
    await expectAlive(app, chrome, 'after the menu closed by a click into the page')

    // And closed by its own button, then opened a second time.
    await openMenu(app, chrome)
    await chrome.click('#menu')
    await menuClosed(app)
    await expectAlive(app, chrome, 'after the menu closed by its button')

    // A question: the chrome has to come back from it as well.
    if (underVirtualDisplay()) {
      await focusWebContents(app, ETH_URL)
      await app.evaluate(() => { void (globalThis as unknown as { __orivonDevDefaultBrowserAskNow?: () => Promise<void> }).__orivonDevDefaultBrowserAskNow?.() })
      await waitQuestion(app)
      await answerQuestion(app, 'Not now')
      expect(await waitFor(async () => !(await popoverShown(app, 'overlay=question')))).toBe(true)
      await expectAlive(app, chrome, 'after the question was answered')
    }

    // The chrome still takes a click: the Menu opens once more.
    await openMenu(app, chrome)
    await chrome.click('#menu')
    await menuClosed(app)

    // The measure itself must be able to fail: with the chrome's animations stopped it reports no movement.
    await chrome.evaluate(() => { document.getAnimations().forEach((animation) => { animation.pause() }) })
    const stalled = await chromeProgress(chrome)
    expect(stalled.animated).toBeLessThan(MIN_ANIMATED_MS)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
