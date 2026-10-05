// What the picker page accepts from main, checked once at the edge so the drawing code can rely on the shape, and the
// grid movement of its cards. Anything that is not the shape closes the overlay rather than drawing half a picker.
import type { PickerView } from '../../../main/display-capture/picker/picker-view.js'

/** Cards per row; the stylesheet draws the grid with the same number. */
export const COLUMNS = 3

const SEGMENTS = ['tab', 'window', 'screen']
const MODES = ['list', 'portal', 'permission']

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string'

export function isCard (value: unknown): boolean {
  return isRecord(value) && typeof value['id'] === 'string' && typeof value['label'] === 'string' && isTextOrNull(value['sub']) &&
    isTextOrNull(value['thumb']) && isTextOrNull(value['icon']) && typeof value['self'] === 'boolean'
}

export const isCards = (value: unknown): boolean => Array.isArray(value) && value.every(isCard)

export function isPickerView (value: unknown): value is PickerView {
  if (!isRecord(value) || typeof value['id'] !== 'string' || typeof value['title'] !== 'string' || typeof value['guardMs'] !== 'number') return false
  const { segments, cards, modes, audio } = value
  if (!Array.isArray(segments) || segments.length === 0 || !segments.every((segment) => SEGMENTS.includes(segment as string)) || !segments.includes(value['segment'])) return false
  if (!isRecord(cards) || !SEGMENTS.every((segment) => isCards(cards[segment]))) return false
  if (!isRecord(modes) || !MODES.includes(modes['window'] as string) || !MODES.includes(modes['screen'] as string)) return false
  return typeof value['permissionText'] === 'string' && isTextOrNull(value['selected']) &&
    isRecord(audio) && typeof audio['tab'] === 'boolean' && typeof audio['system'] === 'boolean' && typeof audio['systemDefault'] === 'boolean'
}

/** Where an arrow, Home or End key moves the selection in a grid of `count` cards `columns` wide; the ends hold. */
export function gridStep (count: number, current: number | null, key: string, columns: number = COLUMNS): number | null {
  if (count === 0) return null
  if (current === null) return 0
  const last = count - 1
  switch (key) {
    case 'ArrowLeft': return Math.max(0, current - 1)
    case 'ArrowRight': return Math.min(last, current + 1)
    case 'ArrowUp': return current - columns >= 0 ? current - columns : current
    case 'ArrowDown': return current + columns <= last ? current + columns : current
    case 'Home': return 0
    case 'End': return last
    default: return current
  }
}
