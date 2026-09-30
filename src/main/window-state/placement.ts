// Where the first window opens, from the place the last-used window had. Pure: the displays come in as
// data, so a monitor that was unplugged is a test case rather than a hardware setup.
import type { Placement } from '../shell/window-options.js'

export interface Rect { x: number, y: number, width: number, height: number }

/** What the store keeps: the window's normal (un-maximised) rectangle, and whether it was maximised. */
export interface SavedPlacement {
  readonly bounds: Rect
  readonly maximized: boolean
}

export interface PlacementPlan {
  /** Absent when the window opens where it always does. */
  readonly place?: Placement
  readonly maximized: boolean
}

export const MIN_WIDTH = 480
export const MIN_HEIGHT = 320
/** How much of the window's top strip must lie on a display for the person to be able to grab the window. */
const GRAB_WIDTH = 120
const GRAB_HEIGHT = 40

export function isRect (value: unknown): value is Rect {
  if (typeof value !== 'object' || value === null) return false
  const { x, y, width, height } = value as Record<string, unknown>
  return [x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n)) && (width as number) > 0 && (height as number) > 0
}

function overlap (aStart: number, aLength: number, bStart: number, bLength: number): number {
  return Math.max(0, Math.min(aStart + aLength, bStart + bLength) - Math.max(aStart, bStart))
}

/** The display holding the window's top strip (the bar it is dragged by), or undefined when none holds enough of
 * it. The strip is measured against `bounds`, not the work area: the work area can be far smaller than the
 * monitor (window-frame.ts). */
function displayHoldingStrip (rect: Rect, displays: readonly { bounds: Rect }[]): Rect | undefined {
  const stripHeight = Math.min(GRAB_HEIGHT, rect.height)
  let best: Rect | undefined
  let bestArea = 0
  for (const { bounds } of displays) {
    const across = overlap(rect.x, rect.width, bounds.x, bounds.width)
    const down = overlap(rect.y, stripHeight, bounds.y, bounds.height)
    if (across < Math.min(GRAB_WIDTH, rect.width) || down < stripHeight) continue
    if (across * down > bestArea) { best = bounds; bestArea = across * down }
  }
  return best
}

function clamp (value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/** `saved` is what the last window left; null means nothing was saved. A place that no display shows is
 * dropped, but a maximised window still opens maximised, on the default display. */
export function placementFor (saved: SavedPlacement | null, displays: readonly { bounds: Rect }[]): PlacementPlan {
  if (saved === null || !isRect(saved.bounds)) return { maximized: false }
  const maximized = saved.maximized
  const display = displayHoldingStrip(saved.bounds, displays)
  if (display === undefined) return { maximized }
  const width = Math.round(clamp(saved.bounds.width, MIN_WIDTH, display.width))
  const height = Math.round(clamp(saved.bounds.height, MIN_HEIGHT, display.height))
  const x = Math.round(clamp(saved.bounds.x, display.x, display.x + display.width - width))
  const y = Math.round(clamp(saved.bounds.y, display.y, display.y + display.height - height))
  return { place: { x, y, width, height }, maximized }
}
