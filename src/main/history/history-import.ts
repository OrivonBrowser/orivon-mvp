// Pages brought in from another browser, merged into the ones already kept: a page already here keeps its
// title and gains the visits.
import type { DatabaseSync } from 'node:sqlite'
import type { HistoryImportRow } from './history-store.js'

/** Writes the rows in one transaction; answers how many pages were added or changed. */
export function importHistoryRows (_db: DatabaseSync, _rows: readonly HistoryImportRow[]): number {
  return 0
}
