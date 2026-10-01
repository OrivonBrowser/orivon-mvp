// What the bubble accepts from main, checked once at the edge so the drawing can rely on the shape. Anything else
// closes the overlay rather than drawing half a list.
import type { PopupsView } from '../../../main/site-settings/popups-view.js'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** The view main sends, checked once at the edge so the drawing below can rely on its shape. */
export function isPopupsView (value: unknown): value is PopupsView {
  if (!isRecord(value) || typeof value['origin'] !== 'string' || typeof value['allowed'] !== 'boolean' ||
    typeof value['settingsLink'] !== 'boolean' || typeof value['more'] !== 'number') return false
  const { rows } = value
  return Array.isArray(rows) && rows.length > 0 && rows.every((row) => isRecord(row) && typeof row['host'] === 'string' && typeof row['url'] === 'string')
}

export function moreText (more: number): string {
  return `and ${String(more)} more`
}
