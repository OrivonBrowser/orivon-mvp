// A listing as it travels to the History page: a site's icon can be tens of kilobytes and a page of a hundred rows of one
// site would carry it a hundred times, so each distinct icon is sent once and a row points at it by position.
import type { HistoryEntry } from './history-store.js'

export type PackedEntry = Omit<HistoryEntry, 'favicon'> & {
  /** The position of the row's icon in the listing's `icons`; absent when the site has none. */
  readonly icon?: number
}

export interface PackedListing {
  readonly entries: PackedEntry[]
  readonly icons: string[]
}

export function packEntries (entries: readonly HistoryEntry[]): PackedListing {
  const icons: string[] = []
  const at = new Map<string, number>()
  const packed = entries.map(({ favicon, ...rest }): PackedEntry => {
    if (typeof favicon !== 'string' || favicon === '') return rest
    let index = at.get(favicon)
    if (index === undefined) {
      index = icons.push(favicon) - 1
      at.set(favicon, index)
    }
    return { ...rest, icon: index }
  })
  return { entries: packed, icons }
}
