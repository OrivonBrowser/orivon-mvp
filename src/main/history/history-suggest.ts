// What the address bar offers from history while someone types, and the count of addresses typed in full.
// Both read and write the store's own `pages` table, which the caller has brought up to date first.
import type { DatabaseSync } from 'node:sqlite'
import type { HistorySuggestion } from './history-store.js'

/** Pages whose address or title the text begins, best first. */
export function suggestPages (_db: DatabaseSync, _text: string, _limit: number): HistorySuggestion[] {
  return []
}

/** Counts the address as typed in full, for a page already in the history. */
export function markPageTyped (_db: DatabaseSync, _url: string): void {}
