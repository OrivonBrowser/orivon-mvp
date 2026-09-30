// What tab search lists, as plain rows the page can filter and draw. Pure: main sends them in the order an
// empty query shows, and the page ranks and highlights them.
import type { ClosedEntry } from '../session-restore/closed-stack.js'
import type { TabState } from '../shell/tab-types.js'

/** Closed entries offered when nothing is typed. */
export const MAX_CLOSED_ROWS = 8
/** A favicon over this many characters is left out, so a show stays small. */
export const MAX_FAVICON_CHARS = 32 * 1024
/** Favicons of one list, together, before the rest go without an icon. */
export const FAVICON_BUDGET_CHARS = 512 * 1024
const MAX_TEXT = 300

export interface SearchTabRow {
  readonly kind: 'tab'
  readonly id: string
  readonly windowKey: number
  readonly title: string
  readonly host: string
  readonly favicon: string | null
  readonly isNewTab: boolean
  readonly pinned: boolean
  readonly audible: boolean
  readonly muted: boolean
  /** The active tab of the window the list was opened in. */
  readonly current: boolean
  /** Which window, counting from 1 in the order the windows were opened, when it is not the one the list is in. */
  readonly otherWindow: number | null
}

export interface SearchClosedRow {
  readonly kind: 'closed'
  readonly entryId: number
  readonly title: string
  readonly host: string
  /** When it was closed, in milliseconds since the epoch. */
  readonly at: number
  /** The tabs it held: more than one only for a closed window. */
  readonly count: number
  readonly window: boolean
}

export type SearchRow = SearchTabRow | SearchClosedRow

export interface SearchWindow {
  /** `BaseWindow.id`. */
  readonly key: number
  /** The window the list is shown in. */
  readonly current: boolean
  readonly tabs: readonly TabState[]
  readonly activeTabId: string | null
}

export interface SearchInput {
  /** In the order the windows were opened. */
  readonly windows: readonly SearchWindow[]
  /** Newest first. */
  readonly closed: readonly ClosedEntry[]
  /** A larger number is a tab activated later. A tab missing from it was not seen activated. */
  readonly lastActive: ReadonlyMap<string, number>
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)

/** An address as a line under a title: no scheme, no trailing slash. */
export function displayHost (address: string): string {
  return oneLine(address.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/$/, ''))
}

/** Only an image data URL small enough to ship: the page puts it in an `<img>`, never anywhere else. */
export function cleanFavicon (favicon: string | null): string | null {
  return favicon !== null && favicon.startsWith('data:image/') && favicon.length <= MAX_FAVICON_CHARS ? favicon : null
}

function tabRows (input: SearchInput): SearchTabRow[] {
  const rows: SearchTabRow[] = []
  // The window the list is in leads, so a tab never used since the list began to be kept still comes first.
  const ordered = [...input.windows.entries()].sort(([, a], [, b]) => Number(b.current) - Number(a.current))
  for (const [index, window] of ordered) {
    for (const tab of window.tabs) {
      rows.push({
        kind: 'tab',
        id: tab.id,
        windowKey: window.key,
        title: oneLine(tab.title),
        host: tab.isNewTab ? '' : displayHost(tab.displayUrl),
        favicon: tab.isNewTab ? null : tab.favicon,
        isNewTab: tab.isNewTab,
        pinned: tab.pinned,
        audible: tab.audible,
        muted: tab.muted,
        current: window.current && tab.id === window.activeTabId,
        otherWindow: window.current ? null : index + 1
      })
    }
  }
  const seen = (row: SearchTabRow): number => input.lastActive.get(row.id) ?? 0
  // Array.prototype.sort is stable: tabs never seen activated keep the order above. The tab the person is on goes last.
  return rows.sort((a, b) => Number(a.current) - Number(b.current) || seen(b) - seen(a))
}

function closedRow (entry: ClosedEntry): SearchClosedRow {
  if (entry.kind === 'tab') {
    return { kind: 'closed', entryId: entry.id, title: oneLine(entry.tab.title || entry.tab.url), host: displayHost(entry.tab.url), at: entry.at, count: 1, window: false }
  }
  const [first] = entry.window.tabs
  const others = entry.window.tabs.length - 1
  const name = first === undefined ? 'Window' : oneLine(first.title || first.url)
  return {
    kind: 'closed',
    entryId: entry.id,
    title: others > 0 ? `${name} and ${String(others)} more` : name,
    host: first === undefined ? '' : displayHost(first.url),
    at: entry.at,
    count: entry.window.tabs.length,
    window: true
  }
}

/** Open tabs most recently used first, the tab the person is on last, then the newest closed entries. */
export function searchRows (input: SearchInput): SearchRow[] {
  let budget = FAVICON_BUDGET_CHARS
  const tabs = tabRows(input).map((row): SearchTabRow => {
    const favicon = cleanFavicon(row.favicon)
    if (favicon === null || favicon.length > budget) return { ...row, favicon: null }
    budget -= favicon.length
    return { ...row, favicon }
  })
  return [...tabs, ...input.closed.slice(0, MAX_CLOSED_ROWS).map(closedRow)]
}
