// Where an extension's popup opens, end to end: a view inside the shell window, never a window of its own,
// under the toolbar icon (or the Extensions button, for one opened from the menu) with its right edge on the
// anchor's, the page's own size, kept inside a narrow window, following its page as it grows, and still open and
// on top after the extension opens a tab.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/extensions/e2e-extensions-popup-placement.test.ts
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { delay, evaluateRetrying, findChrome, HERMETIC_RESOLVER, popoverShown, waitFor } from '../support/smoke-helpers.mjs'
import { closeElectronApp, runPhase } from '../support/e2e-helpers.js'
import { seedFixture, waitRecovered } from './extensions-e2e-helpers.js'

const TEST_TIMEOUT_MS = 180_000
const GAP = 5
const TOLERANCE = 1

let server: Server | undefined

afterAll(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => { server?.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface Rect { x: number, y: number, width: number, height: number }
interface PopupInView { bounds: Rect, index: number, children: number, content: Rect, windows: number }

/** The popup's view among the children of the shell window, with the window's own measures. */
async function popupView (app: ElectronApplication, id: string): Promise<PopupInView | null> {
  return await app.evaluate(({ BaseWindow }, extensionId: string) => {
    const windows = BaseWindow.getAllWindows().length
    for (const win of BaseWindow.getAllWindows()) {
      const children = win.contentView.children
      const index = children.findIndex((child) => (child as unknown as { webContents?: Electron.WebContents }).webContents?.getURL().startsWith(`chrome-extension://${extensionId}/popup.html`) === true)
      const view = children[index]
      if (view !== undefined) return { bounds: view.getBounds(), index, children: children.length, content: win.getContentBounds(), windows }
    }
    return null
  }, id)
}

async function closePopup (app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ BaseWindow }, extensionId: string) => {
    for (const win of BaseWindow.getAllWindows()) {
      for (const child of win.contentView.children) {
        const contents = (child as unknown as { webContents?: Electron.WebContents }).webContents
        if (contents?.getURL().startsWith(`chrome-extension://${extensionId}/popup.html`) === true) contents.close()
      }
    }
  }, id)
  expect(await waitFor(async () => await popupView(app, id) === null)).toBe(true)
}

const windowCount = async (app: ElectronApplication): Promise<number> => await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length)

const iconRect = async (chrome: Page, id: string): Promise<Rect> => await chrome.evaluate((extensionId: string) => {
  const icon = document.querySelector('browser-action-list')?.shadowRoot?.getElementById(extensionId)
  const r = icon?.getBoundingClientRect()
  return { x: r?.x ?? -1, y: r?.y ?? -1, width: r?.width ?? 0, height: r?.height ?? 0 }
}, id)

const buttonRect = async (chrome: Page): Promise<Rect> => await evaluateRetrying(chrome, () => {
  const r = document.getElementById('extensions-menu-btn')?.getBoundingClientRect()
  return { x: r?.x ?? -1, y: r?.y ?? -1, width: r?.width ?? 0, height: r?.height ?? 0 }
})

const popupPage = (app: ElectronApplication, id: string): Page | undefined => app.windows().find((w) => w.url().startsWith(`chrome-extension://${id}/popup.html`))

it('opens an extension popup inside the window under its anchor, in the page\'s own size', async () => {
  const httpServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<title>placement-fixture</title><body>fixture</body>')
  })
  await new Promise<void>((resolve) => { httpServer.listen(0, '127.0.0.1', resolve) })
  server = httpServer
  const address = httpServer.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not report a port')
  const origin = `http://127.0.0.1:${String(address.port)}/`

  await runPhase('extension popup placement', async (check) => {
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    let id = ''
    try {
      app = await launchElectron({
        appPath: '.',
        args: [HERMETIC_RESOLVER],
        seedProfile: async (dir) => { id = seedFixture(dir, 'action-popup') },
        sandbox: true
      })
      const liveApp = app
      expect(await waitFor(() => { try { findChrome(liveApp); return true } catch { return false } })).toBe(true)
      const chrome = findChrome(liveApp)
      expect(await waitFor(async () => (await liveApp.evaluate(({ session }) => session.defaultSession.extensions.getAllExtensions().length)) === 1)).toBe(true)
      await waitRecovered(liveApp)
      expect(await waitFor(async () => (await iconRect(chrome, id)).width > 0)).toBe(true)

      const near = (a: number, b: number): boolean => Math.abs(a - b) <= TOLERANCE

      // From the pinned icon.
      const windowsBefore = await windowCount(liveApp)
      const icon = await iconRect(chrome, id)
      await chrome.click(`#${id}`)
      check('a click on the pinned icon puts the popup in the shell window', await waitFor(async () => await popupView(liveApp, id) !== null))
      // Past its smallest size: the page has been measured.
      await waitFor(async () => ((await popupView(liveApp, id))?.bounds.width ?? 0) > 25, 10_000)
      const fromIcon = await popupView(liveApp, id)
      check('no new window was opened for it', await windowCount(liveApp) === windowsBefore, `${String(windowsBefore)} before, ${String(await windowCount(liveApp))} now`)
      if (fromIcon === null) return
      check('its right edge is the icon\'s', near(fromIcon.bounds.x + fromIcon.bounds.width, icon.x + icon.width), JSON.stringify({ popup: fromIcon.bounds, icon }))
      check('its top is the icon\'s bottom and the gap', near(fromIcon.bounds.y, icon.y + icon.height + GAP), JSON.stringify({ popup: fromIcon.bounds, icon }))
      const page = popupPage(liveApp, id)
      const content = page === undefined ? undefined : await evaluateRetrying(page, () => {
        // The page's own size: its content laid out at its natural width, whatever the view around it is.
        const root = document.documentElement
        root.style.width = 'max-content'
        const rect = root.getBoundingClientRect()
        root.style.width = ''
        return { width: Math.ceil(rect.width), height: Math.ceil(rect.height) }
      })
      check('it has the size of its page, not the fallback size', content !== undefined && Math.abs(fromIcon.bounds.width - content.width) <= 4 && Math.abs(fromIcon.bounds.height - content.height) <= 4 && !(fromIcon.bounds.width === 320 && fromIcon.bounds.height === 400), JSON.stringify({ popup: fromIcon.bounds, content }))

      // Growing keeps the right edge. A virtual display never reports a page's preferred size, so the event Chromium
      // raises for it is raised here, for the size the page would report.
      await liveApp.evaluate(({ BaseWindow }, extensionId: string) => {
        for (const win of BaseWindow.getAllWindows()) {
          for (const child of win.contentView.children) {
            const contents = (child as unknown as { webContents?: Electron.WebContents }).webContents
            if (contents?.getURL().startsWith(`chrome-extension://${extensionId}/popup.html`) === true) (contents as unknown as { emit: (...args: unknown[]) => void }).emit('preferred-size-changed', {}, { width: 420, height: 300 })
          }
        }
      }, id)
      const afterGrowth = await popupView(liveApp, id)
      check('the popup follows its page as it grows', afterGrowth !== null && afterGrowth.bounds.width === 420 && afterGrowth.bounds.height === 300, JSON.stringify(afterGrowth?.bounds))
      check('growing keeps the right edge on the icon\'s', afterGrowth !== null && near(afterGrowth.bounds.x + afterGrowth.bounds.width, icon.x + icon.width), JSON.stringify(afterGrowth?.bounds))
      await closePopup(liveApp, id)

      // From the menu, against the Extensions button.
      expect(await waitFor(async () => (await buttonRect(chrome)).width > 0)).toBe(true)
      await chrome.evaluate(() => { (window as unknown as { orivonShell: { runCommand: (command: string) => void } }).orivonShell.runCommand('extensions.menu') })
      expect(await waitFor(async () => await popoverShown(liveApp, 'overlay=extensions-menu'))).toBe(true)
      const menu = liveApp.windows().find((w) => w.url().includes('overlay=extensions-menu')) as Page
      await menu.waitForSelector('.em .em-head')
      const button = await buttonRect(chrome)
      await menu.click(`[data-key="main:${id}"]`)
      check('a row of the menu puts the popup in the shell window', await waitFor(async () => await popupView(liveApp, id) !== null))
      const fromMenu = await popupView(liveApp, id)
      if (fromMenu !== null) {
        check('opened from the menu, its right edge is the Extensions button\'s', near(fromMenu.bounds.x + fromMenu.bounds.width, button.x + button.width), JSON.stringify({ popup: fromMenu.bounds, button }))
        check('opened from the menu, its top is the button\'s bottom and the gap', near(fromMenu.bounds.y, button.y + button.height + GAP), JSON.stringify({ popup: fromMenu.bounds, button }))
      }

      // Open and on top after the extension opens a tab.
      const created = popupPage(liveApp, id)
      if (created !== undefined) {
        await created.fill('#url', origin)
        await created.click('#create')
        const opened = await waitFor(() => liveApp.windows().some((w) => w.url() === origin))
        await delay(1_000)
        const after = await popupView(liveApp, id)
        check('the extension opened a tab', opened)
        check('the popup is still open after the tab opened', after !== null)
        check('and it is the topmost view of the window', after !== null && after.index === after.children - 1, JSON.stringify(after))
      }
      await closePopup(liveApp, id)

      // Inside a narrow window.
      await liveApp.evaluate(({ BaseWindow }) => { BaseWindow.getAllWindows()[0]?.setContentSize(800, 600) })
      expect(await waitFor(async () => (await liveApp.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]?.getContentBounds().width)) === 800)).toBe(true)
      await delay(800)
      const narrowIcon = await iconRect(chrome, id)
      await chrome.click(`#${id}`)
      check('the popup opens in an 800 px window', await waitFor(async () => await popupView(liveApp, id) !== null))
      const narrow = await popupView(liveApp, id)
      if (narrow !== null) {
        check('and lies inside it', narrow.bounds.x >= 0 && narrow.bounds.x + narrow.bounds.width <= narrow.content.width && narrow.bounds.y + narrow.bounds.height <= narrow.content.height, JSON.stringify({ popup: narrow.bounds, content: narrow.content }))
        check('with its right edge on the icon\'s', near(narrow.bounds.x + narrow.bounds.width, narrowIcon.x + narrowIcon.width), JSON.stringify({ popup: narrow.bounds, icon: narrowIcon }))
      }
    } finally {
      if (app !== undefined) await closeElectronApp(app)
    }
  })
}, TEST_TIMEOUT_MS)
