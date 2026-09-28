// Where a tab dragged over the page would split it. The dragged tab is never the
// one being shown (it would be split from itself), and a point outside the pages'
// area (the window's top) is no edge.
import { zoneAt } from './split-model.js'
import type { Zone } from './split-model.js'
import type { Bounds } from './tab-types.js'

export function splitZoneFor (activeId: string | null, draggedId: string, area: Bounds, point: { x: number, y: number }): Zone | null {
  if (activeId === null || activeId === draggedId) return null
  return zoneAt(area, point)
}
