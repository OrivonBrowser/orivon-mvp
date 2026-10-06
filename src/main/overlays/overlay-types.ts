// What a feature declares to put Orivon HTML above the page, and what the
// per-window host offers back. The host is ./overlay-host.ts; a feature adds
// one OverlayDef here (./overlays.ts) and one page in src/renderer/overlay/.
import type { WindowContext } from '../shell/window-context.js'

export type OverlayPlacement =
  /** Under a chrome rectangle (a toolbar button, a tab), `width` wide. */
  | { kind: 'anchor', width: number, align: 'left' | 'right' | 'center' }
  /** Under the rectangle, as wide as it is (the address bar). */
  | { kind: 'anchor-width' }
  /** Inside the tab area (a find bar, tab search, a sheet). */
  | { kind: 'area', at: 'top-right' | 'top-center' | 'center', width: number }
  /** Beside the page, taking the strip of the window the page area leaves free (see `dockBounds`): full height, and the content never decides its size. */
  | { kind: 'dock' }
  /** Over the whole page area (the pane of the tab in front, in a split window), whatever the content's height. */
  | { kind: 'pane' }

/** A chrome rectangle in the chrome view's client pixels, which are window-content pixels too. */
export interface OverlayAnchor { x: number, y: number, width: number, height: number }

export type OverlayCloseReason = 'request' | 'escape' | 'blur' | 'tab-switch' | 'navigation' | 'layout' | 'replaced' | 'window-closed'

/** Which events dismiss an overlay. `layout` is a window resize, a chrome height change or HTML fullscreen; without it the overlay is repositioned instead. */
export interface OverlayCloseOn { blur: boolean, tabSwitch: boolean, navigation: boolean, layout: boolean }

export const CLOSE_LIKE_POPUP: OverlayCloseOn = { blur: true, tabSwitch: true, navigation: false, layout: true }
export const CLOSE_LIKE_BAR: OverlayCloseOn = { blur: false, tabSwitch: true, navigation: false, layout: false }

export interface OverlayDef {
  /** Also the renderer page key and `?overlay=<name>`. */
  readonly name: string
  readonly placement: OverlayPlacement
  /** Which pre-paint background the view gets: the panel and menu colours of a popover, or `page`, the colour of an Orivon page. */
  readonly surface: 'panel' | 'menu' | 'page'
  readonly focus: 'take' | 'never'
  /** A popup closes the other popups; bars coexist below them; a cover lies under every bar, adopted panel and popup, and is not a popup. */
  readonly layer: 'cover' | 'popup' | 'bar'
  readonly closeOn: OverlayCloseOn
  /** What happens to the view when the overlay closes. `fresh` destroys it at once. `warm` keeps it for the next show and
   * destroys it once it has stayed closed for a minute (a view prewarmed and never shown goes the same way); a show or a
   * prewarm before then keeps it. `resident` keeps it for the life of the window: for an overlay the person types into
   * the moment it opens, which must never wait for a renderer to start. */
  readonly keep: 'fresh' | 'warm' | 'resident'
  /** Content height in px, clamped to the room left: initial 180, min 120, max 460 by default. */
  readonly height?: { initial?: number, min?: number, max?: number }
  /** Runs once per window, on first use. */
  readonly attach: (win: OverlayWindow) => OverlayHandler
}

export interface OverlayWindow extends WindowContext {
  /** Sends an event to this overlay's page. */
  send: (event: unknown) => void
  /** Closes this overlay. */
  close: () => void
  /** Makes a `never` overlay hold the keyboard from now until it closes, for one that shows a text box the person clicks into. Does nothing for one already taking focus. The host always supplies it; a test's fake window may leave it out. */
  takeFocus?: () => void
}

/** A key press seen by an overlay's own page before the page does. */
export interface OverlayKey { readonly key: string, readonly isAutoRepeat: boolean }

export interface OverlayHandler {
  /** Its result goes to the page on every show. The payload is the chrome's, unvalidated: check every field as `request` does. */
  show?: (payload: unknown) => unknown
  /** Untrusted: the page sends anything, so validate every field and run only listed commands. */
  request: (command: unknown) => unknown
  closed?: (reason: OverlayCloseReason) => void
  /** Runs for every key pressed down in this overlay's page, before the page sees it; returning true drops the key. */
  key?: (key: OverlayKey) => boolean
  /** Runs after the host has repositioned this open overlay: a window resize, a chrome height change or HTML fullscreen that did not close it. */
  moved?: () => void
  /** True while what is open must not be closed by a toggle (an unanswered question a button shares a name with): the toggle then does nothing. */
  holdsOnToggle?: () => boolean
  /** Runs once when the window is gone, whether or not the overlay was open: the place to drop a subscription to anything that outlives the window. */
  disposed?: () => void
}

/** `ShellWindow.overlays`. */
export interface OverlayHost {
  show: (name: string, anchor?: OverlayAnchor, payload?: unknown) => void
  /** `pressedAt`, when the toggle is the click of a press the person made, is that press's time on main's clock (see ../shell/press-stamps.ts): the toggle is then the echo of a blur-close that happened at or after it, however long the button was held. */
  toggle: (name: string, anchor?: OverlayAnchor, payload?: unknown, pressedAt?: number) => void
  /** Without a name, closes every popup. */
  close: (name?: string) => void
  isOpen: (name: string) => boolean
  /** Whether a popup is up: a popup-layer overlay, or a legacy panel the host adopted (the site-info and all-sites popups). */
  popupOpen: () => boolean
  /** The control an open overlay hangs from has moved (the address pill, after a resize): it is placed under it again. */
  reanchor: (name: string, anchor: OverlayAnchor) => void
  prewarm: (name: string) => void
  send: (name: string, event: unknown) => void
}

/**
 * What a page's first `ready` call is answered with: the show result it has not seen yet, if a show is waiting,
 * and the events sent while it loaded. The page takes the show first, then the events, so an event is never
 * seen by a page that has not yet been told what it is showing.
 */
export type OverlayReady = ({ shown: false } | { shown: true, payload: unknown }) & { events?: unknown[] }
