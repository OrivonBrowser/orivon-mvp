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

// Placeholder, not yet tuned to a chosen visual concept (this session's
// plan SS "Visual concepts before the chrome UI is built"). Revisit once
// step 5b lands -- the mockups decide the real tab-strip/toolbar height.
const CHROME_HEIGHT = 88

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
