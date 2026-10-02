// What the prompt page accepts from main, checked once at the edge so the
// drawing code below it can rely on the shape. Anything else closes the
// overlay rather than drawing a half-formed question.
import type { AskView, ReviewView } from '../../../main/site-settings/site-prompt-text.js'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')

export function isAskView (value: unknown): value is AskView {
  if (!isRecord(value) || value['mode'] !== 'ask' || typeof value['id'] !== 'string' || typeof value['origin'] !== 'string') return false
  const { lines } = value
  return Array.isArray(lines) && lines.length > 0 && lines.every((line) => isRecord(line) && isStringArray(line['kinds']) && typeof line['text'] === 'string') &&
    (value['locationNote'] === null || typeof value['locationNote'] === 'string') && (value['privateNote'] === null || typeof value['privateNote'] === 'string') && typeof value['guardMs'] === 'number'
}

export function isReviewView (value: unknown): value is ReviewView {
  if (!isRecord(value) || value['mode'] !== 'review' || typeof value['origin'] !== 'string' || typeof value['settingsLink'] !== 'boolean') return false
  const { rows } = value
  return Array.isArray(rows) && rows.length > 0 && rows.every((row) => isRecord(row) && typeof row['kind'] === 'string' && typeof row['label'] === 'string' &&
    (row['value'] === 'ask' || row['value'] === 'allow' || row['value'] === 'block') && typeof row['askOffered'] === 'boolean')
}

/** The segment a Left or Right key reaches from `index` among `count`, without wrapping. */
export function segmentAfterKey (index: number, key: string, count: number): number {
  if (key === 'ArrowLeft') return Math.max(0, index - 1)
  if (key === 'ArrowRight') return Math.min(count - 1, index + 1)
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return index
}
