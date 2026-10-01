// Where the chrome view and the tabs' page area sit in the window. The one
// place a page area is computed: everything that overlays or splits the page
// reads it through `tabBounds`.
import type { BaseWindow, WebContentsView } from 'electron'
import type { Bounds } from './tab-types.js'

/** The tab strip (36px, level with the native window buttons) and the toolbar (40px). The chrome page's CSS repeats these two heights, so the view and the page agree on where the tabs' content starts. */
export const CHROME_TOP_ROWS = 76
export const BOOKMARKS_BAR_HEIGHT = 28
/** The chrome's height while the bookmarks bar shows. */
export const CHROME_HEIGHT = CHROME_TOP_ROWS + BOOKMARKS_BAR_HEIGHT

export interface WindowLayoutDeps {
  readonly win: BaseWindow
  readonly chrome: WebContentsView
  /** The tab holding the whole window, if a page is in HTML fullscreen. */
  readonly fullscreenTabId: () => string | null
  readonly bookmarksBarShown: () => boolean
  /** A kiosk window has no chrome: the page takes the whole window. */
  readonly kiosk?: boolean
}

export interface WindowLayout {
  chromeHeight: () => number
  layoutChrome: () => void
  tabBounds: () => Bounds
}

export function createWindowLayout ({ win, chrome, fullscreenTabId, bookmarksBarShown, kiosk = false }: WindowLayoutDeps): WindowLayout {
  function chromeHeight (): number {
    if (kiosk) return 0
    return bookmarksBarShown() ? CHROME_HEIGHT : CHROME_TOP_ROWS
  }

  function layoutChrome (): void {
    if (win.isDestroyed()) return
    const bounds = win.getContentBounds()
    chrome.setVisible(!kiosk && fullscreenTabId() === null)
    chrome.setBounds({ x: 0, y: 0, width: bounds.width, height: chromeHeight() })
  }

  // A destroyed window has no bounds to give. Its tabs' `destroyed` events
  // arrive after it, and each one can land here through activateTab.
  function tabBounds (): Bounds {
    if (win.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 }
    const bounds = win.getContentBounds()
    const top = fullscreenTabId() === null ? chromeHeight() : 0
    return { x: 0, y: top, width: bounds.width, height: bounds.height - top }
  }

  return { chromeHeight, layoutChrome, tabBounds }
}
