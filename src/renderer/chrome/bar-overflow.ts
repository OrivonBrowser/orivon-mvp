// The bookmarks bar's pure decisions: which items fit, where an arrow key goes, and what an event from main is
// worth. No DOM, so they are tested without one.
import type { BarItem } from '../../main/browsing/bookmark-types.js'

/** The leading items that fit in `available` px. When they all fit the answer is `widths.length`; otherwise room is
 * kept for the "More bookmarks" button of `moreWidth` px, after one `gap`. */
export function visibleCount (widths: readonly number[], available: number, gap: number, moreWidth: number): number {
  const total = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(widths.length - 1, 0)
  if (total <= available) return widths.length
  const budget = available - moreWidth - gap
  let used = 0
  let count = 0
  for (const [index, width] of widths.entries()) {
    const next = used + (index > 0 ? gap : 0) + width
    if (next > budget) break
    used = next
    count += 1
  }
  return count
}

export type BarKey = 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End'

/** The stop an arrow key moves to among `count` stops, from `at`; it stays on the ends rather than wrapping. */
export function nextStop (count: number, at: number, key: BarKey): number {
  if (count <= 0) return -1
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return Math.min(Math.max(at + (key === 'ArrowRight' ? 1 : -1), 0), count - 1)
}

/** The drop position among items whose horizontal centres are `centres`: before the first whose centre is right of `x`. */
export function dropPosition (centres: readonly number[], x: number): number {
  let index = 0
  for (const centre of centres) if (x > centre) index += 1
  return index
}

/** The items an event from main carries, or null when it is not a list of items. */
export function parseBarItems (payload: unknown): BarItem[] | null {
  if (!Array.isArray(payload)) return null
  const items: BarItem[] = []
  for (const entry of payload as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return null
    const { id, kind, title, url, favicon } = entry as Record<string, unknown>
    if (typeof id !== 'string' || typeof title !== 'string' || (kind !== 'url' && kind !== 'folder')) return null
    const item: BarItem = { id, kind, title }
    if (typeof url === 'string') item.url = url
    item.favicon = typeof favicon === 'string' ? favicon : null
    items.push(item)
  }
  return items
}
