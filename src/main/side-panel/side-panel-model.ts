// Where the docked panel sits and how wide it may be: pure arithmetic, no view involved.

export type PanelSide = 'left' | 'right'

export const PANEL_MIN = 280
export const PANEL_MAX = 640
export const PANEL_DEFAULT = 360
/** The page area is never squeezed below this by the panel. */
export const PAGE_MIN = 480
/** A window narrower than this has no panel: the page and the panel would both be unusable. */
export const MIN_WINDOW_WIDTH = 760
/** The strip at the top of the panel: the view picker and the close button. A guest view starts below it. */
export const HEADER_HEIGHT = 40
/** The strip on the page side of the panel that resizes it. */
export const EDGE_WIDTH = 6
/** What one arrow key press moves the resize edge. */
export const KEY_STEP = 16

export function fits (windowWidth: number): boolean {
  return windowWidth >= MIN_WINDOW_WIDTH
}

/** The width kept inside what this window can give: the page keeps `PAGE_MIN`, and the limits win over a tiny window. */
export function clampWidth (width: number, windowWidth: number): number {
  const wanted = Number.isFinite(width) ? Math.round(width) : PANEL_DEFAULT
  const max = Math.max(PANEL_MIN, Math.min(PANEL_MAX, windowWidth - PAGE_MIN))
  return Math.min(max, Math.max(PANEL_MIN, wanted))
}

export interface InsetsInput {
  open: boolean
  side: PanelSide
  width: number
  windowWidth: number
  /** A page holds the whole window (HTML fullscreen). */
  fullscreen: boolean
  /** A kiosk window shows the page and nothing else. */
  kiosk?: boolean
}

/** What the open panel takes from each side of the page area. */
export function insetsFor ({ open, side, width, windowWidth, fullscreen, kiosk = false }: InsetsInput): { left: number, right: number } {
  if (!open || fullscreen || kiosk || !fits(windowWidth)) return { left: 0, right: 0 }
  const taken = clampWidth(width, windowWidth)
  return side === 'left' ? { left: taken, right: 0 } : { left: 0, right: taken }
}
