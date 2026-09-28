// Split view as data: which tabs are shown together, how the window is shared
// between them, and where a tab dropped near an edge would go. Pure: no
// Electron, so all the arithmetic is tested without a window.
import type { Bounds } from './tab-types.js'

export type Orientation = 'row' | 'column'
export type Zone = 'left' | 'right' | 'top' | 'bottom'

/** Two tabs shown together. `a` is the left or top pane and comes first in the strip. */
export interface SplitGroup {
  a: string
  b: string
  orientation: Orientation
  /** The share of the room the first pane has. */
  ratio: number
}

/** The border round the panes, and the gap between them: the gap is what a person drags to resize. */
export const MARGIN = 4
export const GAP = 8
export const MIN_RATIO = 0.2
export const MAX_RATIO = 0.8
/** A pane narrower than this is not worth splitting the window for. */
export const MIN_PANE_PX = 240

export interface PaneRects {
  readonly a: Bounds
  readonly b: Bounds
  readonly divider: Bounds
}

export function clampRatio (ratio: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
}

/** Where the two panes and the divider go in `area`, or null when the area is too small for two panes. */
export function paneRects (area: Bounds, orientation: Orientation, ratio: number): PaneRects | null {
  const along = orientation === 'row' ? area.width : area.height
  const room = along - 2 * MARGIN - GAP
  if (room < 2 * MIN_PANE_PX) return null
  const first = Math.round(room * clampRatio(ratio))
  const second = room - first
  const across = (orientation === 'row' ? area.height : area.width) - 2 * MARGIN
  if (orientation === 'row') {
    const y = area.y + MARGIN
    return {
      a: { x: area.x + MARGIN, y, width: first, height: across },
      b: { x: area.x + MARGIN + first + GAP, y, width: second, height: across },
      divider: { x: area.x + MARGIN + first, y, width: GAP, height: across }
    }
  }
  const x = area.x + MARGIN
  return {
    a: { x, y: area.y + MARGIN, width: across, height: first },
    b: { x, y: area.y + MARGIN + first + GAP, width: across, height: second },
    divider: { x, y: area.y + MARGIN + first, width: across, height: GAP }
  }
}

/** The ratio a divider dragged to `pointer` (along the window's row or column) gives. */
export function ratioAt (area: Bounds, orientation: Orientation, pointer: number): number {
  const room = (orientation === 'row' ? area.width : area.height) - 2 * MARGIN - GAP
  if (room <= 0) return 0.5
  return clampRatio((pointer - (orientation === 'row' ? area.x : area.y) - MARGIN - GAP / 2) / room)
}

/** Which edge of `area` a pointer is near enough to for a tab dropped there to split it, or null in the middle. */
export function zoneAt (area: Bounds, point: { x: number, y: number }, share = 0.28): Zone | null {
  if (point.x < area.x || point.x >= area.x + area.width || point.y < area.y || point.y >= area.y + area.height) return null
  const fx = (point.x - area.x) / area.width
  const fy = (point.y - area.y) / area.height
  // The nearer edge wins where two zones meet in a corner.
  const candidates: Array<[Zone, number]> = [['left', fx], ['right', 1 - fx], ['top', fy], ['bottom', 1 - fy]]
  const nearest = candidates.reduce((best, next) => (next[1] < best[1] ? next : best))
  return nearest[1] < share ? nearest[0] : null
}

/** The half of `area` a zone names, for showing where a dropped tab would go. */
export function zoneHalf (area: Bounds, zone: Zone): Bounds {
  const halfW = Math.round(area.width / 2)
  const halfH = Math.round(area.height / 2)
  switch (zone) {
    case 'left': return { x: area.x, y: area.y, width: halfW, height: area.height }
    case 'right': return { x: area.x + halfW, y: area.y, width: area.width - halfW, height: area.height }
    case 'top': return { x: area.x, y: area.y, width: area.width, height: halfH }
    case 'bottom': return { x: area.x, y: area.y + halfH, width: area.width, height: area.height - halfH }
  }
}

export const orientationOf = (zone: Zone): Orientation => (zone === 'left' || zone === 'right' ? 'row' : 'column')
/** Whether a tab dropped at `zone` is the first pane. */
export const isFirstPane = (zone: Zone): boolean => zone === 'left' || zone === 'top'

/** The groups of one window. A tab is in at most one. */
export class SplitGroups {
  private readonly groups: SplitGroup[] = []

  groupOf (id: string): SplitGroup | undefined {
    return this.groups.find((group) => group.a === id || group.b === id)
  }

  partnerOf (id: string): string | null {
    const group = this.groupOf(id)
    if (group === undefined) return null
    return group.a === id ? group.b : group.a
  }

  /** False when either tab is already in a group, or the two are one. */
  create (a: string, b: string, orientation: Orientation = 'row', ratio = 0.5): boolean {
    if (a === b || this.groupOf(a) !== undefined || this.groupOf(b) !== undefined) return false
    this.groups.push({ a, b, orientation, ratio: clampRatio(ratio) })
    return true
  }

  /** Breaks up the group `id` is in; its tabs stay, alone. */
  separate (id: string): void {
    const at = this.groups.findIndex((group) => group.a === id || group.b === id)
    if (at !== -1) this.groups.splice(at, 1)
  }

  /** The panes trade places. */
  swap (id: string): void {
    const group = this.groupOf(id)
    if (group !== undefined) [group.a, group.b] = [group.b, group.a]
  }

  rotate (id: string): void {
    const group = this.groupOf(id)
    if (group !== undefined) group.orientation = group.orientation === 'row' ? 'column' : 'row'
  }

  setRatio (id: string, ratio: number): void {
    const group = this.groupOf(id)
    if (group !== undefined && Number.isFinite(ratio)) group.ratio = clampRatio(ratio)
  }
}
