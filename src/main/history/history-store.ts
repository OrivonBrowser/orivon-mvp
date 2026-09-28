// What a history store keeps and answers, apart from where it keeps it. The
// interface is the seam: the rest of the shell speaks to it, and the null
// store stands in wherever nothing is to be remembered.

export interface HistoryEntry {
  readonly id: number
  /** The address as the person sees it. */
  readonly url: string
  readonly title: string
  /** Milliseconds since the epoch. */
  readonly lastVisit: number
  readonly visitCount: number
}

export interface HistoryQuery {
  /** Matches part of the title or the address, without regard to case. */
  readonly search?: string
  /** Only entries after this one in the listing: the last entry of the page before. */
  readonly after?: { readonly lastVisit: number, readonly id: number }
  readonly limit?: number
}

export interface HistoryStore {
  readonly kind: 'sqlite' | 'null'
  /** A page was reached. Kept once the write next runs. */
  record: (url: string, title: string, at: number) => void
  /** The title the page settled on, for its most recent visit. */
  setTitle: (url: string, title: string) => void
  /** Most recently visited first. */
  list: (query?: HistoryQuery) => HistoryEntry[]
  count: () => number
  /** Forgets a page and all its visits. */
  remove: (id: number) => void
  /** Forgets the visits made between the two times, and the pages that have none left. */
  removeRange: (from: number, to: number) => void
  clear: () => void
  /** Writes what is waiting. */
  flush: () => void
  close: () => void
}

export const MAX_TITLE_LENGTH = 512
export const MAX_URL_LENGTH = 4096
export const DEFAULT_PAGE_SIZE = 100
export const MAX_PAGE_SIZE = 500

/** Remembers nothing: for a private session, a history turned off, and a database that could not be opened. */
export class NullHistoryStore implements HistoryStore {
  readonly kind = 'null'
  record (): void {}
  setTitle (): void {}
  list (): HistoryEntry[] { return [] }
  count (): number { return 0 }
  remove (): void {}
  removeRange (): void {}
  clear (): void {}
  flush (): void {}
  close (): void {}
}
