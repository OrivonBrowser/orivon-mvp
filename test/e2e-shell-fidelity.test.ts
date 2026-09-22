// What an ordinary web page expects of a browser window, proved against the
// real shell: HTML fullscreen fills the window and Escape gives it back;
// window.open() returns a real window whose opener can be talked to; a
// blob: URL the page minted opens; a beforeunload guard asks instead of
// silently blocking; and the User-Agent names Chrome, not Electron.
//
// DELIBERATELY AN ORDINARY WEBSITE, not an Orivon app: every one of these is
// web-platform behaviour, and each regression broke ordinary sites too.
//
// THE CLICKS ARE THE POINT. Fullscreen, window.open and the beforeunload
// prompt are all driven from real clicks on real buttons, the way a page's
// own UI would be. The refusal without a click is asked by the page itself
// at load: Playwright's `evaluate` runs as a user gesture, so an ask from
// there would prove nothing.
//
// THE ONE THING SUBSTITUTED is the Leave/Stay dialog: a native message box no
// driver here can press, so `dialog.showMessageBoxSync` is replaced in the
// main process with one that answers from a variable -- the same privilege
// Playwright's `evaluate` already has. Escape is sent through
// `webContents.sendInputEvent`, the browser-side input path a real key
// takes; Playwright's own keyboard reaches the page without passing there.
//
// Hermetic: one throwaway server on loopback, nothing else.
import { afterAll, expect, it } from 'vitest'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { ElectronApplication, Page } from 'playwright'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from './launch-electron.mjs'
import { ABSENCE_SETTLE_MS, HERMETIC_RESOLVER, delay, evaluateRetrying, findChrome, findViewShowing, tabIds, waitFor, waitForTab } from './smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, navigateToFixture, runPhase } from './e2e-helpers.js'

const HOST = '127.0.0.1'
// 8872-8884 belong to other suites' fixtures; this file needs one of its own.
const PORT = 8893
const ORIGIN = `http://${HOST}:${PORT}/`
const TITLE = 'shell fidelity fixture'

const PAGE = `<!doctype html><meta charset="utf-8"><title>${TITLE}</title>
<body>
<button id="fs">Full screen</button>
<button id="open">Open popup</button>
<button id="blob">Open blob</button>
<button id="guard">Guard</button>
<script>
  // Asked at load, before anyone has touched the page: the ask a click must gate.
  window.__unprompted = 'pending'
  document.documentElement.requestFullscreen()
    .then(() => { window.__unprompted = 'resolved' }, (e) => { window.__unprompted = e.name })
  window.__fs = 'not-run'
  document.getElementById('fs').addEventListener('click', () => {
    document.documentElement.requestFullscreen()
      .then(() => { window.__fs = 'resolved' })
      .catch((e) => { window.__fs = e.name })
  })
  window.__open = 'not-run'
  window.__message = null
  window.addEventListener('message', (e) => { window.__message = e.data })
  document.getElementById('open').addEventListener('click', () => {
    window.__open = window.open('/child') === null ? 'null' : 'window'
  })
  document.getElementById('blob').addEventListener('click', () => {
    const html = new Blob(['<title>blob page</title>blob'], { type: 'text/html' })
    window.open(URL.createObjectURL(html))
  })
  document.getElementById('guard').addEventListener('click', () => {
    window.addEventListener('beforeunload', (e) => { e.preventDefault() })
  })
</script>
</body>`

// The shape of a sign-in popup's last step: tell the opener, then close.
const CHILD = `<!doctype html><meta charset="utf-8"><title>child</title><body>child<script>
  if (window.opener !== null) window.opener.postMessage('hello from the popup', '*')
</script></body>`

const NEXT = '<!doctype html><meta charset="utf-8"><title>next page</title><body>next</body>'

interface ViewInfo { url: string, visible: boolean, bounds: { x: number, y: number, width: number, height: number } }
interface WindowInfo { fullScreen: boolean, content: { width: number, height: number }, views: ViewInfo[] }

/** The window's own view tree, read in the main process: which views exist,
 * where they sit and whether they are shown. The page cannot see any of it. */
async function windowInfo (app: ElectronApplication): Promise<WindowInfo> {
  return app.evaluate(({ BaseWindow }) => {
    const win = BaseWindow.getAllWindows()[0]
    if (win === undefined) throw new Error('no window')
    const views = win.contentView.children.map((child) => {
      const wc = (child as unknown as { webContents?: Electron.WebContents }).webContents
      return { url: wc?.getURL() ?? '', visible: child.getVisible(), bounds: child.getBounds() }
    })
    return { fullScreen: win.isFullScreen(), content: win.getContentBounds(), views }
  })
}

async function pressEscapeIn (app: ElectronApplication, url: string): Promise<void> {
  await app.evaluate(({ webContents }, target) => {
    const wc = webContents.getAllWebContents().find((c) => c.getURL() === target)
    wc?.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    wc?.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  }, url)
}

interface FixtureState { __fs: string, __open: string, __message: string | null }
const fixtureState = async (view: Page): Promise<FixtureState> =>
  evaluateRetrying(view, () => { const w = window as unknown as FixtureState; return { __fs: w.__fs, __open: w.__open, __message: w.__message } })

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = ADDRESS_BAR_STABLE_TIMEOUT_MS * 3 + DEFAULT_ACTION_TIMEOUT_MS * 8 + APP_CLOSE_RACE_MS + 60_000

it('gives an ordinary page fullscreen, real popups, a leave prompt and a Chrome User-Agent', async () => {
  await runPhase('shell-fidelity', async (check) => {
    let app: ElectronApplication | undefined
    let server: Server | undefined
    const requests: Array<{ url: string, headers: IncomingHttpHeaders }> = []
    try {
      server = createServer((req, res) => {
        requests.push({ url: req.url ?? '', headers: req.headers })
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(req.url === '/child' ? CHILD : req.url === '/next' ? NEXT : PAGE)
      })
      await new Promise<void>((resolve) => { server?.listen(PORT, HOST, resolve) })

      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
      const view = await navigateToFixture(app, ORIGIN, TITLE)
      const chrome = findChrome(app)

      // --- User-Agent ---------------------------------------------------
      const chromeMajor = (await app.evaluate(() => process.versions.chrome)).split('.')[0]
      const pageUa = await evaluateRetrying(view, () => navigator.userAgent)
      const wireUa = String(requests.find((r) => r.url === '/')?.headers['user-agent'])
      for (const [where, ua] of [['navigator.userAgent', pageUa], ['the request header', wireUa]]) {
        check(`${where} names Chrome ${chromeMajor} and neither Electron nor orivon (got ${ua})`,
          ua.includes(` Chrome/${chromeMajor}.0.0.0 `) && !/electron|orivon/i.test(ua))
      }

      // --- Fullscreen ---------------------------------------------------
      let unprompted = 'pending'
      await waitFor(async () => {
        unprompted = await evaluateRetrying(view, () => (window as unknown as { __unprompted: string }).__unprompted)
        return unprompted !== 'pending'
      })
      const stillWindowed = !(await windowInfo(app)).fullScreen
      check(`requestFullscreen() before any click is refused (got ${unprompted})`, unprompted !== 'pending' && unprompted !== 'resolved' && stillWindowed)

      await view.click('#fs')
      const entered = await waitFor(async () => (await fixtureState(view)).__fs === 'resolved')
      check('requestFullscreen() from a click resolves', entered)
      let filled: WindowInfo | undefined
      const fills = await waitFor(async () => {
        filled = await windowInfo(app as ElectronApplication)
        const tab = filled.views.find((v) => v.url === ORIGIN)
        return filled.fullScreen && tab?.bounds.y === 0 && tab.bounds.height === filled.content.height &&
          filled.views.some((v) => v.url.startsWith('file:') && !v.visible)
      })
      check('the tab fills the whole window, the window is fullscreen and the chrome is hidden', fills, JSON.stringify(filled))
      // Its URL reads '' until its first load commits, so this waits too.
      const noticed = await waitFor(async () => (await windowInfo(app as ElectronApplication)).views.some((v) => v.url.startsWith('data:text/html')))
      check('the "Press Esc" notice is on screen', noticed)

      await pressEscapeIn(app, ORIGIN)
      let restored: WindowInfo | undefined
      const left = await waitFor(async () => {
        restored = await windowInfo(app as ElectronApplication)
        const tab = restored.views.find((v) => v.url === ORIGIN)
        const inPage = await evaluateRetrying(view, () => document.fullscreenElement === null)
        return inPage && !restored.fullScreen && tab !== undefined && tab.bounds.y > 0 &&
          restored.views.every((v) => v.visible && !v.url.startsWith('data:'))
      })
      check('Escape leaves fullscreen and gives the window back to the chrome', left, JSON.stringify(restored))

      // --- window.open with an opener -----------------------------------
      await view.click('#open')
      const opened = await waitFor(async () => (await fixtureState(view)).__open === 'window')
      check('window.open() returns a real window, not null', opened)
      const heard = await waitFor(async () => (await fixtureState(view)).__message === 'hello from the popup')
      check('the popup reached its opener through window.opener.postMessage', heard)
      const popupTab = await waitForTab(chrome, { address: `${ORIGIN}child`, title: 'child' })
      check('the popup is the active tab', popupTab.ok, JSON.stringify(popupTab.info))
      const popup = findViewShowing(app, chrome, `${ORIGIN}child`)
      const surface = popup === undefined ? 'no view' : await evaluateRetrying(popup, () => typeof (window as unknown as { orivon?: unknown }).orivon)
      check(`the popup got the ordinary tab preload (window.orivon is ${surface})`, surface === 'object')
      const sameSession = await app.evaluate(({ webContents }, [opener, child]) => {
        const all = webContents.getAllWebContents()
        return all.find((c) => c.getURL() === opener)?.session === all.find((c) => c.getURL() === child)?.session
      }, [ORIGIN, `${ORIGIN}child`])
      check('the popup shares its opener\'s session', sameSession)

      await popup?.evaluate(() => { window.close() }).catch(() => {})
      const closed = await waitFor(async () => (await tabIds(chrome)).length === 1)
      check('window.close() in the popup closes its tab, and only its tab', closed && (await windowInfo(app)).views.length > 0)

      // --- blob: popup --------------------------------------------------
      await view.click('#blob')
      const blobTab = await waitForTab(chrome, { title: 'blob page' })
      const blobInfo = blobTab.info as { address?: string, activeId?: string } | undefined
      check('a blob: URL the page minted opens in a tab', blobTab.ok && String(blobInfo?.address).startsWith(`blob:${ORIGIN.slice(0, -1)}/`), JSON.stringify(blobInfo))
      const blobId = blobInfo?.activeId
      if (blobId !== undefined) await chrome.click(`[data-id="${blobId}"] .close`)
      await waitFor(async () => (await tabIds(chrome)).length === 1)

      // --- beforeunload -------------------------------------------------
      view.on('dialog', () => {}) // Electron answers it; stop Playwright answering too.
      await app.evaluate(({ dialog }) => {
        const g = globalThis as unknown as { __leaveAsked: number, __leaveAnswer: number }
        g.__leaveAsked = 0
        g.__leaveAnswer = 1
        dialog.showMessageBoxSync = ((..._args: unknown[]) => { g.__leaveAsked += 1; return g.__leaveAnswer }) as typeof dialog.showMessageBoxSync
      })
      await view.click('#guard')
      await clickAddressBarRetrying(chrome, `${ORIGIN}next`)
      const askedOnce = await waitFor(async () => await app?.evaluate(() => (globalThis as unknown as { __leaveAsked: number }).__leaveAsked) === 1)
      await delay(ABSENCE_SETTLE_MS)
      const stayed = await evaluateRetrying(view, () => document.title)
      check('a guarded page asks before leaving', askedOnce)
      check(`choosing Stay keeps the page (title is ${stayed})`, stayed === TITLE)

      await app.evaluate(() => { (globalThis as unknown as { __leaveAnswer: number }).__leaveAnswer = 0 })
      await clickAddressBarRetrying(chrome, `${ORIGIN}next`)
      const moved = await waitForTab(chrome, { address: `${ORIGIN}next`, title: 'next page' })
      check('choosing Leave navigates', moved.ok, JSON.stringify(moved.info))
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      if (server !== undefined) await new Promise<void>((resolve) => { server?.close(() => { resolve() }) })
    }
  })
}, TEST_TIMEOUT_MS)
