// The welcome screen as a view over the whole window, above the chrome and the
// dashboard tab that has already loaded beneath it. The page (src/renderer/
// intro/) has no preload: it reports by moving its own URL hash, which is all
// this watches. #asking: "Enter Orivon" opened the telemetry popup, and the page
// wants the browser under it to show blurred, which this hands back as a snapshot.
// #leaving, or #leaving?telemetry=0|1 with the button pressed, then #entered.
// Whether a launch shows it at all is ./intro-state.ts.
import { app, WebContentsView, type BaseWindow } from 'electron'
import { withTimeout } from '../page-tools/with-timeout.js'
import { attachShown } from './attach-view.js'
import { introPageUrl, parseLeaving, type IntroPlan } from './intro-state.js'
import { rendererEntryUrl, validatedDevServerUrl } from './renderer-entry.js'
import type { TabManager } from './tabs.js'
import { SHELL_PARTITION } from './shell-session.js'
import { APP_DARK_WASH } from './theme-colors.js'

// The page's fade-in happens over the app's own dark wash (theme-colors.ts) --
// the same value the new-tab dashboard's own background is.
const BACKDROP = APP_DARK_WASH
const TRANSPARENT = '#00000000'
const ERR_ABORTED = -3
// The snapshot is shown blurred, so detail past this fraction of the window is bytes for nothing.
const SNAPSHOT_SHRINK = 6
const SNAPSHOT_MS = 1500
// A popup asked at start (a renewal) can come before the dashboard has drawn: a snapshot of a blank page is no picture of the browser.
const LOADED_MS = 3000

/** One view under the welcome screen, as a picture: its box in percent of the window, so it stays in place when the window is resized. */
interface BehindLayer { readonly left: number, readonly top: number, readonly width: number, readonly height: number, readonly url: string }

async function loaded (view: WebContentsView): Promise<void> {
  const { webContents } = view
  if (!webContents.isLoading()) return
  let stop = (): void => {}
  const stopped = new Promise<void>((resolve) => { stop = resolve })
  webContents.once('did-stop-loading', stop)
  await withTimeout(stopped, LOADED_MS, 'a view under the welcome screen').catch(() => {})
  webContents.removeListener('did-stop-loading', stop)
}

/**
 * The browser under the welcome screen, bottom view first. A view that cannot be captured is left out, and an
 * empty list leaves the page on its own backdrop: a GPU-less display (the e2e's xvfb) captures nothing.
 */
async function browserBehind (win: BaseWindow, intro: WebContentsView): Promise<BehindLayer[]> {
  const { width, height } = win.getContentBounds()
  if (width <= 0 || height <= 0) return []
  const views = win.contentView.children.filter((child): child is WebContentsView => child !== intro && (child as Partial<WebContentsView>).webContents !== undefined && child.getVisible() && !(child as WebContentsView).webContents.isDestroyed())
  const layers = await Promise.all(views.map(async (view): Promise<BehindLayer | undefined> => {
    const bounds = view.getBounds()
    if (bounds.width <= 0 || bounds.height <= 0) return undefined
    try {
      await loaded(view)
      // Not `stayHidden`: a view the welcome screen covers draws nothing, and a capture is what makes it draw once.
      const image = await withTimeout(view.webContents.capturePage(), SNAPSHOT_MS, 'a view under the welcome screen')
      if (image.isEmpty()) return undefined
      const small = image.resize({ width: Math.max(1, Math.round(bounds.width / SNAPSHOT_SHRINK)), quality: 'good' })
      const percent = (value: number, of: number): number => value / of * 100
      return { left: percent(bounds.x, width), top: percent(bounds.y, height), width: percent(bounds.width, width), height: percent(bounds.height, height), url: small.toDataURL() }
    } catch {
      return undefined
    }
  }))
  return layers.filter((layer): layer is BehindLayer => layer !== undefined)
}

const covered = new WeakSet<BaseWindow>()

/** True while the welcome screen is over `win`: it holds the keyboard, nothing under it may take it, and nothing may be asked in it. */
export function introCovers (win: BaseWindow): boolean { return covered.has(win) }

/** `focusAddressBar` gives the keyboard to the address bar: where it goes on entering, when a new tab is in front. */
export function showIntro (win: BaseWindow, tabs: Pick<TabManager, 'onStateChange' | 'activeWebContents' | 'getState'>, plan: IntroPlan, focusAddressBar: () => void): void {
  const view = new WebContentsView({
    webPreferences: { partition: SHELL_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true }
  })
  const { webContents } = view
  // Opaque until the person is let in: the page fades in over this, not over the
  // dashboard behind it, and only then becomes see-through for the fade-out.
  view.setBackgroundColor(BACKDROP)
  let open = true
  covered.add(win)

  function layout (): void {
    if (win.isDestroyed()) return
    const { width, height } = win.getContentBounds()
    view.setBounds({ x: 0, y: 0, width, height })
  }
  // A macrotask, not synchronously: 'resize' reports the pre-resize bounds
  // under X11 (window.ts has the measurement).
  function onResize (): void { setImmediate(() => { if (open) layout() }) }
  // Switching tabs re-adds that tab's view, which would stack it above this one.
  function keepOnTop (): void {
    if (open && win.contentView.children.at(-1) !== view) attachShown(win.contentView, view)
  }

  function dismiss (): void {
    if (!open) return
    open = false
    covered.delete(win)
    if (!win.isDestroyed()) {
      win.removeListener('resize', onResize)
      win.contentView.removeChildView(view)
    }
    if (!webContents.isDestroyed()) webContents.close()
  }

  // A screen that cannot draw must not leave the window covered by nothing.
  webContents.on('did-fail-load', (_event, errorCode, description, _url, isMainFrame) => {
    if (!isMainFrame || errorCode === ERR_ABORTED) return
    console.error(`[orivon] intro: the welcome screen failed to load (${description}); skipping it`)
    dismiss()
  })
  webContents.on('render-process-gone', () => { dismiss() })

  // Keyboard input goes to the focused view, which is the dashboard's search box under this one until it is asked.
  webContents.once('did-finish-load', () => { if (open && !webContents.isDestroyed()) webContents.focus() })
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  webContents.on('will-navigate', (event) => { event.preventDefault() })
  webContents.on('did-navigate-in-page', (_event, url) => {
    const { hash } = new URL(url)
    const leaving = parseLeaving(hash)
    if (hash === '#asking') {
      if (!plan.offerTelemetry) return
      void browserBehind(win, view).then(async (layers) => {
        if (!open || webContents.isDestroyed() || layers.length === 0) return
        // The page's own listener draws them; the data URLs are main's own captures, never a page's text.
        await webContents.executeJavaScript(`document.dispatchEvent(new CustomEvent('browser-behind', { detail: ${JSON.stringify(layers)} }))`)
      }).catch((error: unknown) => { console.error('[orivon] intro: could not show the browser under the telemetry popup:', error) })
    } else if (leaving !== undefined) {
      view.setBackgroundColor(TRANSPARENT)
      void plan.onEntered()
      // Only the answer to a question the screen was told to ask: a page that did not ask cannot report one.
      if (plan.offerTelemetry && leaving.telemetry !== undefined) void plan.chooseTelemetry(leaving.telemetry).catch((error: unknown) => { console.error('[orivon] intro: could not record the telemetry choice:', error) })
    } else if (hash === '#entered') {
      dismiss()
      const { activeTabId, tabs: all } = tabs.getState()
      if (all.find((tab) => tab.id === activeTabId)?.isNewTab === true) focusAddressBar()
      else tabs.activeWebContents()?.focus()
    }
  })

  layout()
  attachShown(win.contentView, view)
  win.on('resize', onResize)
  // A window closed during the welcome screen: its view is not a child of a
  // window any more, and nothing else would close it.
  win.once('closed', dismiss)
  tabs.onStateChange(keepOnTop)
  const devServerUrl = validatedDevServerUrl(app.isPackaged, process.env['ELECTRON_RENDERER_URL'])
  const page = rendererEntryUrl(devServerUrl, '/intro/', 'intro')
  void webContents.loadURL(introPageUrl(page, plan))
}
