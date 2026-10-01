// Puts each row's icon back from the listing's list of distinct icons (src/main/history/history-pack.ts), so every row of a
// site shares one string rather than holding a copy.
import type { HistoryEntry } from '../../../main/history/history-store.js'

export interface PackedRow extends Omit<HistoryEntry, 'favicon'> {
  readonly icon?: number
}

export function unpackEntries (entries: readonly PackedRow[], icons: readonly string[]): HistoryEntry[] {
  return entries.map(({ icon, ...rest }) => {
    const favicon = icon === undefined ? undefined : icons[icon]
    return favicon === undefined ? rest : { ...rest, favicon }
  })
}
