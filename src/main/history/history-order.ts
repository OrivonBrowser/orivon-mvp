// The listing by most visited or by title, from an offset: the orders `list`'s cursor cannot page through.
import type { DatabaseSync } from 'node:sqlite'
import type { HistoryEntry, HistoryQuery } from './history-store.js'

/** The entries `query` asks for in `query.order` from `query.offset`, each with its icon. */
export function listPagesOrdered (_db: DatabaseSync, _query: HistoryQuery): HistoryEntry[] {
  return []
}
