// Where an overlay sits and how big it is: pure geometry, no view involved.
import type { Bounds } from '../shell/tab-types.js'
import type { OverlayAnchor, OverlayPlacement } from './overlay-types.js'

/** Gap under a toolbar anchor, and the smallest margin kept to the window edges. */
const GAP = 6
const EDGE = 8
/** Under an address bar the gap is tighter: the overlay reads as the bar's own dropdown. */
const ANCHOR_WIDTH_GAP = 4
const AREA_INSET_TOP = 8
const AREA_INSET_RIGHT = 16

export interface OverlayFrame {
  /** The window's content size. */
  width: number
  height: number
  /** The tab area. */
  area: Bounds
}

export interface OverlayLimits { min: number, max: number }

/** The height content asks for, bounded by the def's own limits and then by the room left. The floor wins over a tiny room: a sliver reads as broken. */
function fitHeight (contentHeight: number, limits: OverlayLimits, room: number): number {
  const wanted = Number.isFinite(contentHeight) ? contentHeight : limits.min
  return Math.round(Math.max(limits.min, Math.min(wanted, limits.max, room)))
}

function clampX (x: number, width: number, frameWidth: number): number {
  return Math.round(Math.min(Math.max(x, EDGE), Math.max(EDGE, frameWidth - width - EDGE)))
}

/** Without a rectangle an anchor placement hangs off the toolbar's right end, just under the chrome. */
function anchorlessRect (placement: OverlayPlacement, frame: OverlayFrame): OverlayAnchor {
  if (placement.kind === 'anchor-width') return { x: EDGE, y: frame.area.y - ANCHOR_WIDTH_GAP, width: frame.width - EDGE * 2, height: 0 }
  return { x: frame.width - EDGE, y: frame.area.y - GAP, width: 0, height: 0 }
}

/** A rectangle of finite numbers: what a chrome-side anchor must be before it is used to place a view. */
export function isAnchor (value: unknown): value is OverlayAnchor {
  if (typeof value !== 'object' || value === null) return false
  const rect = value as Record<string, unknown>
  return [rect['x'], rect['y'], rect['width'], rect['height']].every((n) => typeof n === 'number' && Number.isFinite(n))
}

/**
 * The strip of the window the page area leaves free, beside it: on the left when the page starts after x 0,
 * else on the right. Zero wide when the page takes the whole width (the dock is hidden), so a hidden dock
 * needs no state of its own.
 */
export function dockBounds (frame: OverlayFrame): Electron.Rectangle {
  const { area } = frame
  const y = area.y
  const height = Math.max(0, area.height)
  if (area.x > 0) return { x: 0, y, width: area.x, height }
  const x = area.x + area.width
  return { x, y, width: Math.max(0, frame.width - x), height }
}

export function overlayBounds (
  placement: OverlayPlacement,
  anchor: OverlayAnchor | undefined,
  frame: OverlayFrame,
  contentHeight: number,
  limits: OverlayLimits
): Electron.Rectangle {
  if (placement.kind === 'dock') return dockBounds(frame)
  if (placement.kind === 'area') {
    const width = Math.max(0, Math.min(placement.width, frame.width - EDGE * 2))
    const areaBottom = frame.area.y + frame.area.height
    if (placement.at === 'center') {
      const height = fitHeight(contentHeight, limits, frame.area.height - EDGE * 2)
      const x = clampX(frame.area.x + (frame.area.width - width) / 2, width, frame.width)
      return { x, y: Math.round(frame.area.y + Math.max(EDGE, (frame.area.height - height) / 2)), width, height }
    }
    const y = frame.area.y + AREA_INSET_TOP
    const height = fitHeight(contentHeight, limits, areaBottom - y - EDGE)
    const preferredX = placement.at === 'top-right'
      ? frame.area.x + frame.area.width - width - AREA_INSET_RIGHT
      : frame.area.x + (frame.area.width - width) / 2
    return { x: clampX(preferredX, width, frame.width), y: Math.round(y), width, height }
  }

  const rect = anchor ?? anchorlessRect(placement, frame)
  const gap = placement.kind === 'anchor-width' ? ANCHOR_WIDTH_GAP : GAP
  const y = Math.round(rect.y + rect.height + gap)
  const height = fitHeight(contentHeight, limits, frame.height - y - EDGE)
  if (placement.kind === 'anchor-width') {
    const width = Math.max(0, Math.min(rect.width, frame.width - EDGE * 2))
    return { x: clampX(rect.x, width, frame.width), y, width, height }
  }
  const width = Math.max(0, Math.min(placement.width, frame.width - EDGE * 2))
  const preferredX = placement.align === 'right'
    ? rect.x + rect.width - width
    : placement.align === 'center' ? rect.x + rect.width / 2 - width / 2 : rect.x
  return { x: clampX(preferredX, width, frame.width), y, width, height }
}
