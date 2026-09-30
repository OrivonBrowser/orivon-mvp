// The welcome screen as a view over the whole window, above the chrome and the
// dashboard tab that has already loaded beneath it. The page (src/renderer/
// intro/) has no preload: it reports "Enter Orivon" by moving its own URL hash
// to #leaving and then #entered, which is all this watches. Whether a launch
// shows it at all is ./intro-state.ts.
import { app, WebContentsView, type BaseWindow } from 'electron'
import type { IntroPlan } from './intro-state.js'
import { rendererEntryUrl, validatedDevServerUrl } from './renderer-entry.js'
import type { TabManager } from './tabs.js'
import { SHELL_PARTITION } from './shell-session.js'
import { APP_DARK_WASH } from './theme-colors.js'

// The page's fade-in happens over the app's own dark wash (theme-colors.ts) --
// the same value the new-tab dashboard's own background is.
const BACKDROP = APP_DARK_WASH
const TRANSPARENT = '#00000000'
const ERR_ABORTED = -3

export function showIntro (win: BaseWindow, tabs: Pick<TabManager, 'onStateChange' | 'activeWebContents'>, plan: IntroPlan): void {
  const view = new WebContentsView({
    webPreferences: { partition: SHELL_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true }
  })
  const { webContents } = view
  // Opaque until the person clicks: the page fades in over this, not over the
  // dashboard behind it, and only then becomes see-through for the fade-out.
  view.setBackgroundColor(BACKDROP)
  let open = true

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
    if (open && win.contentView.children.at(-1) !== view) win.contentView.addChildView(view)
  }

  function dismiss (): void {
    if (!open) return
    open = false
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

  webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  webContents.on('will-navigate', (event) => { event.preventDefault() })
  webContents.on('did-navigate-in-page', (_event, url) => {
    const { hash } = new URL(url)
    if (hash === '#leaving') {
      view.setBackgroundColor(TRANSPARENT)
      void plan.onEntered()
    } else if (hash === '#entered') {
      dismiss()
      // The dashboard's search box already asked for focus while it was covered.
      tabs.activeWebContents()?.focus()
    }
  })

  layout()
  win.contentView.addChildView(view)
  win.on('resize', onResize)
  // A window closed during the welcome screen: its view is not a child of a
  // window any more, and nothing else would close it.
  win.once('closed', dismiss)
  tabs.onStateChange(keepOnTop)
  const devServerUrl = validatedDevServerUrl(app.isPackaged, process.env['ELECTRON_RENDERER_URL'])
  void webContents.loadURL(rendererEntryUrl(import.meta.dirname, devServerUrl, '/intro/', '../renderer/intro/index.html'))
}
