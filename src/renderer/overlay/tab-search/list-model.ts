// What the tab search list shows for a query, and which row is selected. Pure: the page only draws it.
import type { SearchRow } from '../../../main/tab-search/tab-search-model.js'
import { matchRow } from './fuzzy.js'
import type { Range } from './fuzzy.js'

export interface Item {
  readonly key: string
  readonly row: SearchRow
  readonly title: string
  readonly titleRanges: readonly Range[]
  readonly hostRanges: readonly Range[]
}

export interface Group {
  readonly id: 'open' | 'closed'
  readonly label: string
  readonly items: readonly Item[]
}

/** How many rows one Page Down or Page Up moves. */
export const PAGE_STEP = 8

export const keyOf = (row: SearchRow): string => row.kind === 'tab' ? `tab:${row.id}` : `closed:${String(row.entryId)}`

export function titleOf (row: SearchRow): string {
  if (row.kind === 'tab' && row.isNewTab) return 'New tab'
  return row.title !== '' ? row.title : row.host !== '' ? row.host : 'Untitled'
}

/**
 * The groups for `query`, empty ones dropped. With no query the rows keep the order main gave; with one they
 * are ranked, and equal ranks keep that order. `hidden` holds rows the person just closed, gone at once
 * rather than when main's next update says so.
 */
export function groupsFor (rows: readonly SearchRow[], query: string, hidden: ReadonlySet<string> = new Set()): Group[] {
  const open: Item[] = []
  const closed: Item[] = []
  const ranked: Array<{ item: Item, score: number }> = []
  for (const row of rows) {
    const key = keyOf(row)
    if (hidden.has(key)) continue
    const title = titleOf(row)
    const match = matchRow(query, title, row.host)
    if (match === null) continue
    ranked.push({ item: { key, row, title, titleRanges: match.titleRanges, hostRanges: match.hostRanges }, score: match.score })
  }
  if (query.trim() !== '') ranked.sort((a, b) => b.score - a.score)
  for (const { item } of ranked) (item.row.kind === 'tab' ? open : closed).push(item)
  const groups: Group[] = [
    { id: 'open', label: 'Open tabs', items: open },
    { id: 'closed', label: 'Recently closed', items: closed }
  ]
  return groups.filter((group) => group.items.length > 0)
}

export const flatten = (groups: readonly Group[]): Item[] => groups.flatMap((group) => [...group.items])

/** The key `delta` places from `current`; arrow keys wrap round the ends and paging stops at them. */
export function move (keys: readonly string[], current: string | null, delta: number, wrap: boolean): string | null {
  if (keys.length === 0) return null
  const at = current === null ? -1 : keys.indexOf(current)
  if (at === -1) return delta > 0 ? keys[0] ?? null : keys.at(-1) ?? null
  const next = at + delta
  if (wrap) return keys[((next % keys.length) + keys.length) % keys.length] ?? null
  return keys[Math.min(keys.length - 1, Math.max(0, next))] ?? null
}

/**
 * The selection once the list has changed: the same row if it is still there, else the row that took its
 * place, else the last one.
 */
export function reconcile (before: readonly string[], selected: string | null, after: readonly string[]): string | null {
  if (after.length === 0) return null
  if (selected !== null && after.includes(selected)) return selected
  const at = selected === null ? 0 : Math.max(0, before.indexOf(selected))
  return after[Math.min(at, after.length - 1)] ?? null
}

/** "14 tabs", or "14 tabs in 2 windows". */
export function countLine (rows: readonly SearchRow[]): string {
  const tabs = rows.filter((row) => row.kind === 'tab')
  const windows = new Set(tabs.map((row) => row.kind === 'tab' ? row.windowKey : 0)).size
  const text = `${String(tabs.length)} ${tabs.length === 1 ? 'tab' : 'tabs'}`
  return windows > 1 ? `${text} in ${String(windows)} windows` : text
}

/** What a closed row says where an open one shows its marks. */
export function agoText (at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' })
  // The short style abbreviates with a full stop ("2 min. ago"); the row reads better without it.
  const say = (value: number, unit: Intl.RelativeTimeFormatUnit): string => format.format(-value, unit).replace(/\.(?= ago)/, '')
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return say(Math.round(seconds / 60), 'minute')
  if (seconds < 86_400) return say(Math.round(seconds / 3600), 'hour')
  return say(Math.round(seconds / 86_400), 'day')
}
