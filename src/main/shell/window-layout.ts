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

export interface PageInsets { left: number, right: number }

export interface WindowLayoutDeps {
  readonly win: BaseWindow
  readonly chrome: WebContentsView
  /** The tab holding the whole window, if a page is in HTML fullscreen. */
  readonly fullscreenTabId: () => string | null
  readonly bookmarksBarShown: () => boolean
  /** What a docked panel takes from each side of the page area; zero while none shows. */
  readonly pageInsets?: () => PageInsets
  /** A kiosk window has no chrome: the page takes the whole window. */
  readonly kiosk?: boolean
}

/** While a tab is pressed the chrome view grows to the right by this many window widths, and downward by this many window heights (see `chromeRect`). */
const REACH_WINDOWS = 1
/** A press nobody released (the window lost the pointer) gives the chrome its own size back after this long. */
const REACH_LIMIT_MS = 30_000

export interface WindowLayout {
  chromeHeight: () => number
  layoutChrome: () => void
  tabBounds: () => Bounds
  /** Makes the chrome view wider and taller, under the pages, or gives it its own size back. */
  reachChrome: (on: boolean) => void
}

/** The chrome view's rectangle in a window of `content` size. Normally the top rows. `reach` makes it wider and taller
 * past the right and bottom edges: the browser starts a drag of the chrome's page only when the pointer event that
 * began it lies inside the view, so a quick flick out of the tab strip would begin outside it and be refused without a
 * `dragend`. Its corner stays put, since a move of it would lay the strip out again under the pointer and pick another
 * tab to drag, so a flick past the left or top edge is not covered. The page keeps the width it had (native-tab-drag.ts),
 * so the strip does not move. The view lies under the pages, which cover what it adds below the chrome. */
export function chromeRect (content: { width: number, height: number }, rows: number, reach: boolean): Bounds {
  if (!reach) return { x: 0, y: 0, width: content.width, height: rows }
  return { x: 0, y: 0, width: content.width * (1 + REACH_WINDOWS), height: content.height * (1 + REACH_WINDOWS) }
}

export function createWindowLayout ({ win, chrome, fullscreenTabId, bookmarksBarShown, pageInsets, kiosk = false }: WindowLayoutDeps): WindowLayout {
  let reach = false
  let reachTimer: ReturnType<typeof setTimeout> | null = null

  function chromeHeight (): number {
    if (kiosk) return 0
    return bookmarksBarShown() ? CHROME_HEIGHT : CHROME_TOP_ROWS
  }

  function layoutChrome (): void {
    if (win.isDestroyed()) return
    const bounds = win.getContentBounds()
    chrome.setVisible(!kiosk && fullscreenTabId() === null)
    chrome.setBounds(chromeRect(bounds, chromeHeight(), reach))
  }

  // A destroyed window has no bounds to give. Its tabs' `destroyed` events
  // arrive after it, and each one can land here through activateTab.
  function tabBounds (): Bounds {
    if (win.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 }
    const bounds = win.getContentBounds()
    const fullscreen = fullscreenTabId() !== null
    const top = fullscreen ? 0 : chromeHeight()
    // A page in HTML fullscreen holds the whole window.
    const { left, right } = fullscreen || pageInsets === undefined ? { left: 0, right: 0 } : pageInsets()
    return { x: left, y: top, width: Math.max(0, bounds.width - left - right), height: bounds.height - top }
  }

  function reachChrome (on: boolean): void {
    if (reachTimer !== null) clearTimeout(reachTimer)
    reachTimer = null
    if (on) reachTimer = setTimeout(() => { reachChrome(false) }, REACH_LIMIT_MS)
    if (reach === on) return
    reach = on
    layoutChrome()
  }

  return { chromeHeight, layoutChrome, tabBounds, reachChrome }
}
