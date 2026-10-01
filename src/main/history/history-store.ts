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
  /** The site's icon as a data URL; absent when the site has none or the listing did not look. */
  readonly favicon?: string | null
}

/** A page the address bar may offer for what was typed. */
export interface HistorySuggestion {
  readonly url: string
  readonly title: string
  readonly visitCount: number
  /** How often the address was typed rather than followed. */
  readonly typedCount: number
  readonly lastVisit: number
}

/** One page brought in from another browser. */
export interface HistoryImportRow {
  readonly url: string
  readonly title: string
  readonly lastVisit: number
  readonly visitCount: number
}

export type HistoryOrder = 'recent' | 'visits' | 'title'

export interface HistoryQuery {
  /** Matches part of the title or the address, without regard to case. */
  readonly search?: string
  /** Only entries after this one in the listing: the last entry of the page before. */
  readonly after?: { readonly lastVisit: number, readonly id: number }
  readonly limit?: number
  /** What `listOrdered` sorts by; `list` always answers most recent first. Absent means `'recent'`. */
  readonly order?: HistoryOrder
  /** Entries to skip, for an order that has no `after` cursor. */
  readonly offset?: number
}

export interface HistoryStore {
  readonly kind: 'sqlite' | 'null'
  /** A page was reached. Kept once the write next runs. */
  record: (url: string, title: string, at: number) => void
  /** The title the page settled on, for its most recent visit. */
  setTitle: (url: string, title: string) => void
  /** Most recently visited first. */
  list: (query?: HistoryQuery) => HistoryEntry[]
  /** Pages the text was begun for, best first: what the address bar offers while someone types. */
  suggest: (text: string, limit: number) => HistorySuggestion[]
  /** The address was typed in full, not followed. */
  markTyped: (url: string) => void
  /** Keeps the site's icon, replacing the one it had. */
  setFavicon: (host: string, dataUrl: string) => void
  /** The icon of each host that has one. */
  faviconsFor: (hosts: readonly string[]) => Record<string, string>
  /** Forgets the icons of sites that no page in the history belongs to. */
  pruneFavicons: () => void
  /** Like `list`, in `query.order` and from `query.offset`, each entry with its `favicon`. */
  listOrdered: (query?: HistoryQuery) => HistoryEntry[]
  /** The pages with these ids, in the order given, for acting on rows a page named by id. */
  pagesByIds: (ids: readonly number[]) => HistoryEntry[]
  /** Adds pages from another browser; answers how many were kept. */
  importPages: (rows: readonly HistoryImportRow[]) => number
  count: () => number
  /** Forgets a page and all its visits. */
  remove: (id: number) => void
  /** Forgets each of these pages, in one write. */
  removeMany: (ids: readonly number[]) => void
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
  suggest (): HistorySuggestion[] { return [] }
  markTyped (): void {}
  setFavicon (): void {}
  faviconsFor (): Record<string, string> { return {} }
  pruneFavicons (): void {}
  listOrdered (): HistoryEntry[] { return [] }
  pagesByIds (): HistoryEntry[] { return [] }
  importPages (): number { return 0 }
  count (): number { return 0 }
  remove (): void {}
  removeMany (): void {}
  removeRange (): void {}
  clear (): void {}
  flush (): void {}
  close (): void {}
}
