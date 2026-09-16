// Queue item 4.4's permissions surface, as an in-window panel hanging off
// the toolbar's permission key -- owner, 2026-09-16, replacing the separate
// BaseWindow this used to open. A browser does not send you to another
// window to see what a site may do, and neither should this.
//
// It is its own WebContentsView rather than a region of the chrome view:
// the chrome view is exactly CHROME_HEIGHT tall (window.ts) and growing it
// to hold a panel would need window-level transparency to avoid painting an
// opaque band over the page -- and Electron only honours a transparent View
// inside a `transparent: true` window, which the shell's is not, by design.
// A separate view sized to the panel needs none of that.

import { ipcMain, WebContentsView, type BaseWindow, type View } from 'electron'
import { join } from 'node:path'
import { SETTINGS_COMMAND_CHANNEL } from './channels.js'
import type { PermissionsController } from './permissions.js'
import { rendererEntryUrl } from './renderer-entry.js'
import { registerSettingsIpc } from './settings-ipc.js'

const WIDTH = 380
const MAX_HEIGHT = 460
/** Until the page reports its real content height, and a floor under it --
 * a popup that opens as a 24px sliver while the list loads reads as broken. */
const INITIAL_HEIGHT = 180
const MIN_HEIGHT = 120
/** Gap under the toolbar icon, and the smallest margin kept to the window
 * edges so the panel never sits flush against them. */
const GAP = 6
const EDGE = 8
const CORNER_RADIUS = 10

/** Where the toolbar's permission key is, in the chrome view's own client
 * coordinates. The chrome view is pinned at 0,0 with the window's full
 * width (window.ts's layoutChrome), so these are also window-content
 * coordinates -- no translation, and nothing here needs to know how tall
 * the chrome currently is. */
export interface PanelAnchor {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface PermissionsPanel {
  /** Clicking the key again while the panel is open closes it, the way
   * every browser's own toolbar popup behaves. */
  toggle: (anchor: PanelAnchor, focusOrigin: string | undefined) => void
  close: () => void
  isOpen: () => boolean
}

function panelBounds (win: BaseWindow, anchor: PanelAnchor, contentHeight: number): Electron.Rectangle {
  const { width: winWidth, height: winHeight } = win.getContentBounds()

  // Right-aligned to the icon, then pulled back inside the window -- the key
  // sits near the right edge, so a left-aligned panel would hang off it.
  const preferredX = anchor.x + anchor.width - WIDTH
  const x = Math.round(Math.min(Math.max(preferredX, EDGE), Math.max(EDGE, winWidth - WIDTH - EDGE)))
  const y = Math.round(anchor.y + anchor.height + GAP)

  // Sized to its content, then bounded twice: by MAX_HEIGHT so a long list
  // does not become a full-height slab, and by the room actually left below
  // the toolbar so it is never cut off by the window edge. Past either, the
  // list scrolls inside the panel.
  const room = winHeight - y - EDGE
  const height = Math.round(Math.max(MIN_HEIGHT, Math.min(contentHeight, MAX_HEIGHT, room)))
  return { x, y, width: Math.min(WIDTH, winWidth - EDGE * 2), height }
}

export function createPermissionsPanel (
  win: BaseWindow,
  contentView: View,
  permissions: PermissionsController,
  dirname: string
): PermissionsPanel {
  let view: WebContentsView | null = null

  function close (): void {
    if (view === null) return
    const closing = view
    // Cleared BEFORE the teardown below, not after: closing the webContents
    // can fire its own 'blur' synchronously, which re-enters this function.
    // Without this the second pass would remove an already-removed child and
    // call close() on a destroyed webContents, and an uncaught throw in a
    // main-process callback takes the whole browser down (the same failure
    // class tabs.ts's own 'destroyed' guard exists for).
    view = null
    ipcMain.removeHandler(SETTINGS_COMMAND_CHANNEL)
    contentView.removeChildView(closing)
    if (!closing.webContents.isDestroyed()) closing.webContents.close()
  }

  function open (anchor: PanelAnchor, focusOrigin: string | undefined): void {
    const url = rendererEntryUrl(dirname, process.env['ELECTRON_RENDERER_URL'], '/settings/', '../renderer/settings/index.html')

    const panel = new WebContentsView({
      webPreferences: {
        preload: join(dirname, '../preload/settings.js'),
        additionalArguments: [
          `--orivon-settings-url=${url}`,
          ...(focusOrigin !== undefined ? [`--orivon-focus-origin=${focusOrigin}`] : [])
        ],
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true
      }
    })
    view = panel

    // Added last, so it renders above the active tab's view. Tab switches
    // and clicks into the page both blur this webContents, which closes the
    // panel below -- so it can never be left stranded under a view that was
    // attached after it.
    contentView.addChildView(panel)
    panel.setBorderRadius(CORNER_RADIUS)
    panel.setBounds(panelBounds(win, anchor, INITIAL_HEIGHT))

    registerSettingsIpc(panel.webContents, permissions, (contentHeight) => {
      // Guarded on `view === panel`: a height reported by a panel that has
      // already been dismissed must not resize the one that replaced it.
      if (view !== panel || panel.webContents.isDestroyed()) return
      panel.setBounds(panelBounds(win, anchor, contentHeight))
    })
    void panel.webContents.loadURL(url)

    // Click-away dismissal, the one behaviour that makes this feel like a
    // toolbar popup rather than a stuck overlay. Focus is taken explicitly
    // once the page is ready: a view that never held focus can never blur,
    // and the panel would then stay open forever.
    panel.webContents.once('did-finish-load', () => {
      if (view === panel && !panel.webContents.isDestroyed()) panel.webContents.focus()
    })
    panel.webContents.on('blur', () => { if (view === panel) close() })
  }

  return {
    toggle (anchor, focusOrigin) {
      if (view !== null) { close(); return }
      open(anchor, focusOrigin)
    },
    close,
    isOpen: () => view !== null
  }
}
