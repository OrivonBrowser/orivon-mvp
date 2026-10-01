// Where a dragged row would land, from the pointer and the rows' boxes. Pure: the page measures, this decides.

export interface RowBox {
  readonly id: string
  readonly top: number
  readonly bottom: number
  readonly folder: boolean
}

export type Drop =
  /** Inside this folder, at its end. */
  | { readonly kind: 'into', readonly id: string }
  /** Between rows: `index` is a position in the folder's list as it stands, `line` the y of the mark to draw. */
  | { readonly kind: 'between', readonly index: number, readonly line: number }

/** The middle half of a folder's row files inside it; the outer quarters are the gaps either side. */
const INSIDE_FROM = 0.25
const INSIDE_TO = 0.75

export function dropAt (y: number, boxes: readonly RowBox[], dragged: ReadonlySet<string>): Drop | null {
  const first = boxes[0]
  const last = boxes.at(-1)
  if (first === undefined || last === undefined) return null
  if (y < first.top) return { kind: 'between', index: 0, line: first.top }
  if (y >= last.bottom) return { kind: 'between', index: boxes.length, line: last.bottom }
  const at = boxes.findIndex((box) => y >= box.top && y < box.bottom)
  if (at === -1) {
    // In the gap between two rows: the gap before the next one.
    const next = boxes.findIndex((candidate) => candidate.top > y)
    const after = boxes[next]
    return after === undefined ? null : { kind: 'between', index: next, line: after.top }
  }
  const box = boxes[at]
  if (box === undefined) return null
  const along = (y - box.top) / Math.max(1, box.bottom - box.top)
  if (box.folder && !dragged.has(box.id) && along >= INSIDE_FROM && along <= INSIDE_TO) return { kind: 'into', id: box.id }
  const index = along < 0.5 ? at : at + 1
  return { kind: 'between', index, line: along < 0.5 ? box.top : box.bottom }
}

/** Where Alt+Up or Alt+Down sends the chosen rows within their folder (a position as it stands), or null at an end. */
export function nudgeIndex (ids: readonly string[], chosen: ReadonlySet<string>, direction: 'up' | 'down'): number | null {
  const at = ids.flatMap((id, index) => chosen.has(id) ? [index] : [])
  const first = at[0]
  const last = at.at(-1)
  if (first === undefined || last === undefined) return null
  if (direction === 'up') return first === 0 ? null : first - 1
  return last >= ids.length - 1 ? null : last + 2
}
