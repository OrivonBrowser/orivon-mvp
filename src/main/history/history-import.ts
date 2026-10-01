// Pages brought in from another browser, merged into the ones already kept: a page already here keeps its
// title (unless it has none) and gains the visits. What is brought in is filtered first, because the rows
// come from a file this browser did not write.
import type { DatabaseSync } from 'node:sqlite'
import { historyAddress } from './attach-history.js'
import { MAX_TITLE_LENGTH, MAX_URL_LENGTH } from './history-store.js'
import type { HistoryImportRow } from './history-store.js'
import { rollback } from './history-schema.js'

const DAY_MS = 24 * 60 * 60 * 1000
/** Most pages one import keeps, newest first. */
export const MAX_IMPORTED_PAGES = 20_000
/** A page claiming more visits than this is taken to be wrong. */
const MAX_VISIT_COUNT = 1_000_000

export interface ImportFilter {
  readonly now: number
  /** How far back history is kept, in days; null keeps it all. */
  readonly retentionDays: number | null
  readonly limit: number
}

/** The rows that may be kept: an address the recorder would have kept, a visit that has happened and is not older than the
 * retention, each under the address the person sees; the newest `limit` of them. */
export function selectImportRows (rows: readonly HistoryImportRow[], { now, retentionDays, limit }: ImportFilter): HistoryImportRow[] {
  const oldest = retentionDays === null ? 0 : now - retentionDays * DAY_MS
  const kept: HistoryImportRow[] = []
  for (const row of rows) {
    const lastVisit = Math.trunc(row.lastVisit)
    if (!Number.isFinite(lastVisit) || lastVisit <= 0 || lastVisit > now || lastVisit < oldest) continue
    const url = historyAddress(row.url)
    if (url === null || url.length > MAX_URL_LENGTH) continue
    const visitCount = Number.isFinite(row.visitCount) ? Math.min(Math.max(Math.trunc(row.visitCount), 1), MAX_VISIT_COUNT) : 1
    kept.push({ url, title: row.title.slice(0, MAX_TITLE_LENGTH), lastVisit, visitCount })
  }
  kept.sort((a, b) => b.lastVisit - a.lastVisit)
  return kept.slice(0, Math.max(limit, 0))
}

/** Writes the rows in one transaction; answers how many pages were added or changed. A page that is not here yet is
 * added only while `room` lasts, so an import never pushes the person's own history out. A visit already recorded at
 * the same time is taken to be this page again, so importing twice changes nothing. */
export function importHistoryRows (db: DatabaseSync, rows: readonly HistoryImportRow[], room: number = Number.POSITIVE_INFINITY): number {
  if (rows.length === 0) return 0
  const find = db.prepare('SELECT id FROM pages WHERE url = ?')
  const seen = db.prepare('SELECT 1 AS found FROM visits WHERE page_id = ? AND at = ?')
  const insertPage = db.prepare('INSERT INTO pages (url, title, last_visit, visit_count) VALUES (?, ?, ?, ?)')
  const merge = db.prepare("UPDATE pages SET last_visit = MAX(last_visit, ?), visit_count = visit_count + ?, title = CASE WHEN title = '' THEN ? ELSE title END WHERE id = ?")
  const insertVisit = db.prepare('INSERT INTO visits (page_id, at) VALUES (?, ?)')
  let changed = 0
  let left = room
  db.exec('BEGIN')
  try {
    for (const row of rows) {
      const found = find.get(row.url) as { id: number } | undefined
      if (found === undefined) {
        if (left <= 0) continue
        left -= 1
        const id = Number(insertPage.run(row.url, row.title, row.lastVisit, row.visitCount).lastInsertRowid)
        insertVisit.run(id, row.lastVisit)
      } else {
        if (seen.get(found.id, row.lastVisit) !== undefined) continue
        merge.run(row.lastVisit, row.visitCount, row.title, found.id)
        insertVisit.run(found.id, row.lastVisit)
      }
      changed += 1
    }
    db.exec('COMMIT')
  } catch (error) {
    rollback(db)
    throw error
  }
  return changed
}
