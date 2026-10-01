// What the panel's list is made of, apart from the document: which rows show, where a key moves the selection,
// how a match is marked and how a tree folds. Pure, so every rule is tested without a page.
import type { PanelRow } from '../../../main/side-panel/panel-types.js'
import { dayLabel, timeLabel } from '../../pages/history/days.js'

export type { PanelRow }

/** A row as the page draws it: a day heading is a row of its own, and a history row's time is already worded. */
export type ShownRow = PanelRow

export interface Piece { text: string, hit: boolean }

/** `text` cut at every place the query occurs, ignoring case. A blank query is one piece, unmarked. */
export function pieces (text: string, query: string): Piece[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [{ text, hit: false }]
  const lower = text.toLowerCase()
  const out: Piece[] = []
  let from = 0
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    if (at > from) out.push({ text: text.slice(from, at), hit: false })
    out.push({ text: text.slice(at, at + needle.length), hit: true })
    from = at + needle.length
  }
  if (from < text.length) out.push({ text: text.slice(from), hit: false })
  return out.length === 0 ? [{ text, hit: false }] : out
}

/**
 * Puts a heading above each run of rows that share a day, and words each row's time. The days are the
 * person's own, from the clock handed in. Rows with no time pass through unchanged.
 */
export function withDays (rows: readonly PanelRow[], now: number, locale?: string): ShownRow[] {
  const out: ShownRow[] = []
  let label = ''
  for (const row of rows) {
    if (row.kind !== 'item' || row.at === undefined) {
      out.push(row)
      continue
    }
    const day = dayLabel(row.at, now, locale)
    if (day !== label) {
      label = day
      out.push({ id: `day-${day}`, kind: 'header', title: day })
    }
    out.push({ ...row, meta: timeLabel(row.at, locale) })
  }
  return out
}

/** The ids a key can land on, in screen order: headings are skipped. */
export const selectableIds = (rows: readonly ShownRow[]): string[] => rows.filter((row) => row.kind !== 'header').map((row) => row.id)

export type Move = 'up' | 'down' | 'first' | 'last'

/** Where a movement key goes from `selected`; the first row when nothing is selected, and the ends hold. */
export function moveSelection (ids: readonly string[], selected: string | null, how: Move): string | null {
  if (ids.length === 0) return null
  const at = selected === null ? -1 : ids.indexOf(selected)
  switch (how) {
    case 'first': return ids[0] ?? null
    case 'last': return ids.at(-1) ?? null
    case 'up': return ids[Math.max(0, at === -1 ? 0 : at - 1)] ?? null
    case 'down': return ids[Math.min(ids.length - 1, at + 1)] ?? null
  }
}

/** What stays selected after the list changed: the same row if it is still there, else the one that took its place. */
export function reconcile (before: readonly string[], selected: string | null, now: readonly string[]): string | null {
  if (selected === null || now.length === 0) return null
  if (now.includes(selected)) return selected
  const at = before.indexOf(selected)
  if (at === -1) return null
  return before.slice(at + 1).find((id) => now.includes(id)) ?? [...before.slice(0, at)].reverse().find((id) => now.includes(id)) ?? null
}

export type TreeKeyResult = { action: 'expand' | 'collapse', id: string } | { action: 'select', id: string } | null

/** What Left and Right do on the selected tree row: fold it, unfold it, or step to its parent or first child. */
export function treeKey (rows: readonly ShownRow[], selected: string | null, key: 'ArrowLeft' | 'ArrowRight'): TreeKeyResult {
  const at = rows.findIndex((row) => row.id === selected)
  const row = rows[at]
  if (row === undefined) return null
  if (key === 'ArrowRight') {
    if (row.kind !== 'folder') return null
    if (row.expanded !== true) return { action: 'expand', id: row.id }
    const next = rows[at + 1]
    return next !== undefined && (next.level ?? 0) > (row.level ?? 0) ? { action: 'select', id: next.id } : null
  }
  if (row.kind === 'folder' && row.expanded === true) return { action: 'collapse', id: row.id }
  const level = row.level ?? 0
  if (level === 0) return null
  for (let back = at - 1; back >= 0; back -= 1) {
    const candidate = rows[back]
    if (candidate !== undefined && candidate.kind === 'folder' && (candidate.level ?? 0) < level) return { action: 'select', id: candidate.id }
  }
  return null
}

/** The sentence an empty list shows: what will appear, or that nothing matched the query. */
export function emptyText (query: string, things: string, empty: string): string {
  const typed = query.trim()
  if (typed === '') return empty
  const shown = typed.length > 40 ? `${typed.slice(0, 40)}…` : typed
  return `No ${things} match "${shown}".`
}

/** Which button of a pointer press says where the row opens. */
export function howOpens (event: { button: number, ctrlKey: boolean, metaKey: boolean, shiftKey: boolean }): 'current' | 'background' | 'window' {
  if (event.button === 1 || event.ctrlKey || event.metaKey) return 'background'
  return event.shiftKey ? 'window' : 'current'
}
