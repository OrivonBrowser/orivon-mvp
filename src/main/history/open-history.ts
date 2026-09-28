// Opens the history file. A file that cannot be used (damaged, or from a newer
// version) is never silently replaced or deleted: history is off for the run
// and the reason is kept, for Settings to show.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { NullHistoryStore } from './history-store.js'
import type { HistoryStore } from './history-store.js'
import { SqliteHistoryStore } from './sqlite-history-store.js'

export interface OpenedHistory {
  readonly store: HistoryStore
  /** Why the file could not be used, when it could not. */
  readonly problem: string | null
}

export function openHistory (path: string): OpenedHistory {
  try {
    mkdirSync(dirname(path), { recursive: true })
    return { store: new SqliteHistoryStore(path), problem: null }
  } catch (error) {
    const problem = error instanceof Error ? error.message : String(error)
    console.warn('[orivon] history could not be opened; it is off for this run:', error)
    return { store: new NullHistoryStore(), problem }
  }
}
