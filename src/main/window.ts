// Composes the shell: a frameless BaseWindow holding a chrome
// WebContentsView (tab strip + toolbar) on top and, below it, whichever tab
// WebContentsView is active. See docs/architecture -- there is no shell doc,
// this file and its neighbours (tabs.ts, ipc.ts) are the specification.
//
// Frameless, kept cheap (owner decision, 2026-08-26; this session's plan):
// titleBarStyle: 'hidden' + titleBarOverlay lets Electron draw native
// minimise/maximise/close on Windows/Linux; trafficLightPosition keeps
// macOS's native traffic lights, just repositioned. Verified empirically
// against this Electron version before writing this file (BaseWindow
// accepts all three options; win.setTitleBarOverlay exists) -- context7's
// docs only show these on BrowserWindow examples, and BaseWindow's own
// constructor-options doc doesn't enumerate them, so this was checked
// rather than assumed.
import { BaseWindow, WebContentsView, screen } from 'electron'
import { join } from 'node:path'
import { TabManager, type Bounds } from './tabs.js'
import { registerShellIpc } from './ipc.js'

const STATE_CHANNEL = 'orivon-shell:state'

// Owner picked concept 2 ("dense, filled-pill active tab") from the
// mockups, 2026-08-26. Height is the sum of that concept's three rows,
// mirrored exactly in src/renderer/style.css so the native chrome view
// and the CSS agree on where the tab content starts:
//   titlerow  40px (fixed, matches titleBarOverlay.height below)
// + tabrow    7 + 27 + 6 = 40px (padding-top 7, tab height 27, padding-bottom 6)
// + toolbar   6 + 26 + 6 = 38px (padding 6 top/bottom, address bar height 26)
const CHROME_HEIGHT = 118

export function createShellWindow (): BaseWindow {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize

  const win = new BaseWindow({
    width: Math.min(1280, width),
    height: Math.min(800, height),
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#202124',
      symbolColor: '#e8eaed',
      height: 40
    },
    trafficLightPosition: { x: 16, y: 14 }
  })

  const chrome = new WebContentsView({
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/shell.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })
  win.contentView.addChildView(chrome)

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl !== undefined) {
    void chrome.webContents.loadURL(devServerUrl)
  } else {
    void chrome.webContents.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  function layoutChrome (): void {
    const bounds = win.getContentBounds()
    chrome.setBounds({ x: 0, y: 0, width: bounds.width, height: CHROME_HEIGHT })
  }

  function tabBounds (): Bounds {
    const bounds = win.getContentBounds()
    return { x: 0, y: CHROME_HEIGHT, width: bounds.width, height: bounds.height - CHROME_HEIGHT }
  }

  const tabs = new TabManager(win.contentView, tabBounds)

  tabs.onStateChange((state) => {
    chrome.webContents.send(STATE_CHANNEL, state)
  })

  // Real race, found by end-to-end verification (2026-08-26): tabs.createTab()
  // below pushes state before the chrome page has loaded far enough to
  // register its ipcRenderer listener (shell.ts's contextBridge exposure
  // runs, but main.ts's shell.onState() call hasn't executed yet), so the
  // very first tab silently failed to render until some later event
  // happened to trigger a second push. did-finish-load fires after the
  // page's module script has run (main.ts registers onState before that),
  // so this re-sync is guaranteed to land, not timing-dependent.
  chrome.webContents.on('did-finish-load', () => {
    chrome.webContents.send(STATE_CHANNEL, tabs.getState())
  })

  registerShellIpc(chrome.webContents, tabs)

  win.on('resize', () => {
    layoutChrome()
    tabs.layout()
  })

  layoutChrome()
  tabs.createTab()

  // Electron's type declarations only put 'ready-to-show' on BrowserWindow's
  // typed event union; BaseWindow's own doc doesn't enumerate it either.
  // Verified empirically against this Electron version (2026-08-26) that it
  // fires on BaseWindow all the same -- a type-declaration gap, not a
  // runtime one. Narrow cast, not a cast of `win` to the wrong class.
  ;(win as unknown as { once: (event: 'ready-to-show', cb: () => void) => void })
    .once('ready-to-show', () => win.show())

  return win
}
