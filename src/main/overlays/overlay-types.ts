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
  /** Which pre-paint background the view gets. */
  readonly surface: 'panel' | 'menu'
  readonly focus: 'take' | 'never'
  /** A popup closes the other popups; bars coexist below them. */
  readonly layer: 'popup' | 'bar'
  readonly closeOn: OverlayCloseOn
  /** `fresh` destroys the view on close; `warm` keeps it for the next show. */
  readonly keep: 'fresh' | 'warm'
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
}

export interface OverlayHandler {
  /** Its result goes to the page on every show. The payload is the chrome's, unvalidated: check every field as `request` does. */
  show?: (payload: unknown) => unknown
  /** Untrusted: the page sends anything, so validate every field and run only listed commands. */
  request: (command: unknown) => unknown
  closed?: (reason: OverlayCloseReason) => void
  /** Runs once when the window is gone, whether or not the overlay was open: the place to drop a subscription to anything that outlives the window. */
  disposed?: () => void
}

/** `ShellWindow.overlays`. */
export interface OverlayHost {
  show: (name: string, anchor?: OverlayAnchor, payload?: unknown) => void
  toggle: (name: string, anchor?: OverlayAnchor, payload?: unknown) => void
  /** Without a name, closes every popup. */
  close: (name?: string) => void
  isOpen: (name: string) => boolean
  prewarm: (name: string) => void
  send: (name: string, event: unknown) => void
}

/**
 * What a page's first `ready` call is answered with: the show result it has not seen yet, if a show is waiting,
 * and the events sent while it loaded. The page takes the show first, then the events, so an event is never
 * seen by a page that has not yet been told what it is showing.
 */
export type OverlayReady = ({ shown: false } | { shown: true, payload: unknown }) & { events?: unknown[] }
