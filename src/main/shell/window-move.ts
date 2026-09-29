// The arithmetic behind a manual window move (drag-mode.ts's own doc on why
// Linux/X11 needs one): where the window goes as the pointer moves, how a
// maximized window restores under the pointer instead of snapping to its own
// centre, and which edge of a display an Aero-snap-style release tiles
// against. Pure: no Electron, so all of it is tested without a window.

export interface Point { readonly x: number, readonly y: number }
export interface Rect { readonly x: number, readonly y: number, readonly width: number, readonly height: number }

/** Where within the window the pointer took hold, captured once when a manual drag starts. `proportionX` is
 * kept alongside the plain pixel offset because a maximized window restores to a different width than the
 * one the grab was measured against, and only a proportion of the width survives that change unchanged. */
export interface DragGrab {
  readonly dx: number
  readonly dy: number
  readonly proportionX: number
}

export function grabFor (pointer: Point, bounds: Rect): DragGrab {
  const dx = pointer.x - bounds.x
  return { dx, dy: pointer.y - bounds.y, proportionX: bounds.width === 0 ? 0 : dx / bounds.width }
}

/** The window's new top-left for an ordinary move: the grab offset never changes shape underneath it. */
export function positionFor (pointer: Point, grab: DragGrab): Point {
  return { x: Math.round(pointer.x - grab.dx), y: Math.round(pointer.y - grab.dy) }
}

/** Where a maximized window restores to, the moment a drag starts moving it: kept at the same horizontal
 * share of the window the pointer originally grabbed, rather than jumping to wherever unmaximizing would
 * otherwise centre it. `restoredWidth` is the window's own width once already unmaximized. */
export function restorePositionFor (pointer: Point, restoredWidth: number, grab: DragGrab): Point {
  return { x: Math.round(pointer.x - restoredWidth * grab.proportionX), y: Math.round(pointer.y - grab.dy) }
}

export type EdgeZone = 'maximize' | 'left' | 'right' | null

/** Which edge of `workArea` a released pointer is close enough to for an Aero-snap-style tile: the top edge
 * maximizes, the left or right edge takes that half. `edge`, in pixels, is how close counts -- narrow enough
 * that a window already flush with an edge (the common case just after a tile) can still be dragged away
 * from it without the release re-triggering the same edge action. */
export function edgeZoneFor (pointer: Point, workArea: Rect, edge = 2): EdgeZone {
  if (pointer.y < workArea.y + edge) return 'maximize'
  if (pointer.x < workArea.x + edge) return 'left'
  if (pointer.x >= workArea.x + workArea.width - edge) return 'right'
  return null
}

/** The half of a display's work area a tiled window takes. */
export function halfOfWorkArea (workArea: Rect, zone: 'left' | 'right'): Rect {
  const half = Math.round(workArea.width / 2)
  return zone === 'left'
    ? { x: workArea.x, y: workArea.y, width: half, height: workArea.height }
    : { x: workArea.x + half, y: workArea.y, width: workArea.width - half, height: workArea.height }
}
