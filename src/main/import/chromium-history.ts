// The pages of a Chromium `History` database, newest first. Chromium counts microseconds from 1601, which
// is beyond what a JavaScript number holds exactly, so the division to milliseconds happens in the query.
import type { DatabaseSync } from 'node:sqlite'
import type { HistoryImportRow } from '../history/history-store.js'

const WEBKIT_EPOCH_OFFSET_MS = 11_644_473_600_000

export interface HistoryReadOptions {
  /** The most rows to read. */
  readonly limit: number
  /** Nothing visited before this (milliseconds since 1970). */
  readonly sinceMs: number
}

export function readChromiumHistory (db: DatabaseSync, { limit, sinceMs }: HistoryReadOptions): HistoryImportRow[] {
  const rows = db.prepare(`
    SELECT url, title, visit_count AS visits, last_visit_time / 1000 AS millis FROM urls
    WHERE last_visit_time / 1000 >= ? ORDER BY last_visit_time DESC LIMIT ?
  `).all(Math.max(sinceMs, 0) + WEBKIT_EPOCH_OFFSET_MS, limit)
  const out: HistoryImportRow[] = []
  for (const row of rows) {
    const { url, title, visits, millis } = row as { url: unknown, title: unknown, visits: unknown, millis: unknown }
    if (typeof url !== 'string' || typeof millis !== 'number') continue
    out.push({
      url,
      title: typeof title === 'string' ? title : '',
      lastVisit: millis - WEBKIT_EPOCH_OFFSET_MS,
      visitCount: typeof visits === 'number' && visits > 0 ? Math.trunc(visits) : 1
    })
  }
  return out
}
