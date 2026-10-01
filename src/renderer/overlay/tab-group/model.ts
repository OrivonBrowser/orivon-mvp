// The parts of the group bubble that decide something, kept free of the document so they are unit-tested.
import type { GroupBubbleModel } from '../../../main/tab-groups/tab-group-overlay.js'

export type { GroupBubbleModel }

const COLORS: readonly string[] = ['gray', 'blue', 'red', 'orange', 'green', 'pink', 'purple', 'teal']

export function isModel (value: unknown): value is GroupBubbleModel {
  if (typeof value !== 'object' || value === null) return false
  const model = value as Record<string, unknown>
  return typeof model['title'] === 'string' && typeof model['color'] === 'string' && COLORS.includes(model['color']) &&
    typeof model['count'] === 'number' && typeof model['collapsed'] === 'boolean' && Array.isArray(model['colors'])
}

/** "Blue", for a swatch's accessible name. */
export function colorName (color: string): string {
  return `${color.charAt(0).toUpperCase()}${color.slice(1)}`
}

/** What the close row says: first what it does to how many tabs, then, armed, that a second click does it. */
export function closeLabel (count: number, armed: boolean): string {
  const tabs = `${String(count)} ${count === 1 ? 'tab' : 'tabs'}`
  return armed ? `Click again to close ${tabs}` : 'Close group'
}

/** The swatch an arrow key reaches from `at`, wrapping at both ends. */
export function nextSwatch (count: number, at: number, key: 'ArrowLeft' | 'ArrowRight'): number {
  if (count <= 0) return -1
  return key === 'ArrowRight' ? (at + 1) % count : (at - 1 + count) % count
}
