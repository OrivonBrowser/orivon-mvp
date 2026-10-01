// chrome.history's shapes and the pure decisions behind it: a stored page as a `HistoryItem`, a `search`
// query as a window of time and a row limit, and the events derived by comparing what the history shows
// now with what it showed at the last change (the service says only that something changed).
import type { HistoryEntry } from '../../history/history-store.js'

export interface HistoryItem {
  id: string
  url: string
  title: string
  lastVisitTime: number
  visitCount: number
  /** The history keeps no per-page count of typed visits that this API can read. */
  typedCount: number
}

export interface VisitItem {
  id: string
  visitId: string
  visitTime: number
  referringVisitId: string
  transition: 'link'
  isLocal: true
}

export const DAY_MS = 24 * 60 * 60 * 1000
export const DEFAULT_MAX_RESULTS = 100
export const MAX_RESULTS = 1000

export const toHistoryItem = (entry: HistoryEntry): HistoryItem => ({
  id: String(entry.id), url: entry.url, title: entry.title, lastVisitTime: entry.lastVisit, visitCount: entry.visitCount, typedCount: 0
})

/** One row per address is kept, so one visit stands for it. */
export const toVisitItem = (entry: HistoryEntry): VisitItem => ({
  id: String(entry.id), visitId: String(entry.id), visitTime: entry.lastVisit, referringVisitId: '0', transition: 'link', isLocal: true
})

/** A time as Chrome takes it: milliseconds since the epoch, or a Date. */
export function timeOf (value: unknown, what: string): number {
  const ms = value instanceof Date ? value.getTime() : value
  if (typeof ms !== 'number' || !Number.isFinite(ms)) throw new Error(`Invalid argument: ${what} must be a time in milliseconds since the epoch.`)
  return ms
}

export interface SearchWindow {
  readonly text: string
  /** Included. */
  readonly from: number
  /** Excluded. */
  readonly to: number
  readonly limit: number
}

/** Chrome's defaults: the last 24 hours, up to 100 rows. */
export function searchWindow (query: unknown, now: number): SearchWindow {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) throw new Error('Invalid argument: the query must be an object.')
  const given = query as Record<string, unknown>
  if (given.text !== undefined && typeof given.text !== 'string') throw new Error('Invalid argument: text must be a string.')
  const max = given.maxResults
  if (max !== undefined && (typeof max !== 'number' || !Number.isFinite(max))) throw new Error('Invalid argument: maxResults must be a number.')
  return {
    text: (given.text as string | undefined) ?? '',
    from: given.startTime === undefined ? now - DAY_MS : timeOf(given.startTime, 'startTime'),
    to: given.endTime === undefined ? Number.MAX_SAFE_INTEGER : timeOf(given.endTime, 'endTime'),
    limit: Math.min(Math.max(Math.trunc((max as number | undefined) ?? DEFAULT_MAX_RESULTS), 1), MAX_RESULTS)
  }
}

export type HistoryEvent =
  | { readonly type: 'visited', readonly item: HistoryItem }
  | { readonly type: 'removed', readonly allHistory: boolean, readonly urls: string[] }

/** How many of the newest pages are compared on each change. */
export const WATCH_WINDOW = 200

/**
 * What happened between `before` (the newest pages at the last change, by id) and `fresh` (the newest
 * pages now, newest first, at most `size`). A page new or visited again is a visit; a page that was
 * among the newest and is gone, though nothing newer pushed it out of the window, was removed. A
 * history emptied altogether is `allHistory`.
 */
export function diffHistory (before: ReadonlyMap<number, HistoryEntry>, fresh: readonly HistoryEntry[], size = WATCH_WINDOW): HistoryEvent[] {
  const events: HistoryEvent[] = []
  const now = new Set(fresh.map((entry) => entry.id))
  const full = fresh.length >= size
  const oldest = fresh.at(-1)?.lastVisit ?? 0
  const gone = [...before.values()].filter((entry) => !now.has(entry.id) && (!full || entry.lastVisit >= oldest))
  if (gone.length > 0) {
    events.push({ type: 'removed', allHistory: fresh.length === 0, urls: fresh.length === 0 ? [] : gone.map((entry) => entry.url) })
  }
  for (const entry of [...fresh].reverse()) {
    const known = before.get(entry.id)
    if (known === undefined || entry.lastVisit > known.lastVisit || entry.visitCount > known.visitCount) {
      events.push({ type: 'visited', item: toHistoryItem(entry) })
    }
  }
  return events
}
