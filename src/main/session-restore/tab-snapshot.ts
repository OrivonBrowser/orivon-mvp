// What is written down about one tab so it can come back: its address, its title and whether it was pinned.
// Never the page's form state or scroll position: a snapshot is read by anything running as the person,
// and it is checked again on every read (`sanitizeSnapshot`).
import type { WebContents } from 'electron'
import { sanitizeDirectUrl } from '../browsing/omnibox.js'
import { internalUrl, isInternalPageId, parseInternalUrl } from '../pages/internal-pages.js'
import type { InternalPageId } from '../pages/internal-pages.js'
import type { TabRecord } from '../shell/tab-types.js'

export const MAX_TITLE_LENGTH = 300
export const MAX_URL_LENGTH = 8192
export const MAX_INTERNAL_PATH_LENGTH = 2048
/** Back and forward entries kept per tab: the ones nearest the page shown. */
export const MAX_HISTORY_ENTRIES = 50
/** Groups kept per window. */
export const MAX_SAVED_GROUPS = 50

export interface HistoryEntry {
  readonly url: string
  readonly title: string
}

export interface TabSnapshot {
  readonly url: string
  readonly title: string
  readonly pinned: boolean
  /** One of the shell's own pages: `url` is then its `orivon://` address. */
  readonly internal?: { readonly page: InternalPageId, readonly path: string }
  /** The tab's back and forward list, `index` being the entry shown. Absent for a tab with no history. */
  readonly entries?: readonly HistoryEntry[]
  readonly index?: number
  /** Where in the window's `groups` the tab's group is. Absent for a tab in none. */
  readonly group?: number
}

function asObject (value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

function cleanTitle (value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_TITLE_LENGTH) : ''
}

function cleanUrl (value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return null
  return sanitizeDirectUrl(value)
}

/** The entries of a history list that are addresses a tab may open, with the shown one's new position; null when the shown one is not among them. */
function cleanHistory (rawEntries: unknown, rawIndex: unknown, shown: string): { entries: HistoryEntry[], index: number } | null {
  if (!Array.isArray(rawEntries) || typeof rawIndex !== 'number' || !Number.isInteger(rawIndex)) return null
  const entries: HistoryEntry[] = []
  let index = -1
  for (const [position, raw] of rawEntries.slice(0, MAX_HISTORY_ENTRIES).entries()) {
    const candidate = asObject(raw)
    const url = cleanUrl(candidate?.['url'])
    if (candidate === null || url === null) continue
    if (position === rawIndex) index = entries.length
    entries.push({ url, title: cleanTitle(candidate['title']) })
  }
  return index !== -1 && entries[index]?.url === shown && entries.length > 1 ? { entries, index } : null
}

function cleanGroupIndex (value: unknown): { group?: number } {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < MAX_SAVED_GROUPS ? { group: value } : {}
}

/** A snapshot as the rules allow it, or null. Reads what the file says as data: an address a tab could not have opened, a page that does not exist or an oversize value is refused. */
export function sanitizeSnapshot (raw: unknown): TabSnapshot | null {
  const candidate = asObject(raw)
  if (candidate === null) return null
  const pinned = candidate['pinned'] === true
  const title = cleanTitle(candidate['title'])
  const internal = asObject(candidate['internal'])
  if (internal !== null) {
    const { page, path } = internal
    if (!isInternalPageId(page) || page === 'private' || typeof path !== 'string' || path.length > MAX_INTERNAL_PATH_LENGTH || !path.startsWith('/')) return null
    const address = parseInternalUrl(internalUrl(page, path))
    if (address?.page !== page) return null
    return { url: internalUrl(address.page, address.path), title, pinned, internal: address, ...cleanGroupIndex(candidate['group']) }
  }
  const url = cleanUrl(candidate['url'])
  if (url === null) return null
  const history = cleanHistory(candidate['entries'], candidate['index'], url)
  return { url, title, pinned, ...(history === null ? {} : history), ...cleanGroupIndex(candidate['group']) }
}

/** The window of at most `MAX_HISTORY_ENTRIES` entries around the one shown. */
export function boundHistory (entries: readonly HistoryEntry[], index: number): { entries: HistoryEntry[], index: number } {
  if (entries.length <= MAX_HISTORY_ENTRIES) return { entries: [...entries], index }
  const start = Math.max(0, Math.min(index - Math.floor(MAX_HISTORY_ENTRIES / 2), entries.length - MAX_HISTORY_ENTRIES))
  return { entries: entries.slice(start, start + MAX_HISTORY_ENTRIES), index: index - start }
}

function historyOf (wc: WebContents): { entries: HistoryEntry[], index: number } | null {
  try {
    const all = wc.navigationHistory.getAllEntries()
    if (all.length < 2) return null
    // Address and title only: `pageState` holds what was typed into forms.
    return boundHistory(all.map(({ url, title }) => ({ url, title })), wc.navigationHistory.getActiveIndex())
  } catch {
    return null
  }
}

/** What a tab was opened from, until its page commits: `getURL()` is empty before that, and a tab still waiting on a
 * slow server would otherwise be written down as nothing and lost from the next start. */
const openedFrom = new WeakMap<TabRecord, TabSnapshot>()

export function rememberOpenedFrom (record: TabRecord, snapshot: TabSnapshot): void {
  openedFrom.set(record, snapshot)
}

/**
 * The tab as it would be written down, or null when it is not worth bringing back: the new-tab page, a
 * page that is gone, and any address a tab would refuse to open (`view-source:`, a blob, `about:blank`).
 */
export function snapshotOf (record: TabRecord, wc: WebContents): TabSnapshot | null {
  const pinned = record.pinned === true
  // A sleeping tab's view is blank, so what the page was comes from what sleeping kept.
  if (record.sleeping != null) {
    const { url, title, entries, index } = record.sleeping
    // Address and title only: `pageState` holds what was typed into forms.
    return sanitizeSnapshot({ url, title, pinned, ...boundHistory(entries.map((entry) => ({ url: entry.url, title: entry.title })), index) })
  }
  if (record.isDashboardTab || wc.isDestroyed()) return null
  const title = wc.getTitle()
  if (record.internalPage !== null) {
    const address = parseInternalUrl(wc.getURL()) ?? openedFrom.get(record)?.internal ?? { page: record.internalPage, path: '/' }
    return sanitizeSnapshot({ url: internalUrl(address.page, address.path), title, pinned, internal: address })
  }
  const url = wc.getURL()
  if (url === '') {
    const before = openedFrom.get(record)
    return before === undefined ? null : sanitizeSnapshot({ ...before, title: title === '' ? before.title : title, pinned })
  }
  openedFrom.delete(record)
  return sanitizeSnapshot({ url, title, pinned, ...historyOf(wc) })
}
