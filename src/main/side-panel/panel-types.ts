// The shape of a view the panel draws and of the rows it hands the page. A view reads a store in main; the page
// only ever sees rows and sends back the id of one, and a row's address is looked up from the store, never taken
// from the page.
import type { InternalPageId } from '../pages/internal-pages.js'
import type { WindowContext } from '../shell/window-context.js'

export type PanelIcon = 'bookmarks' | 'history' | 'reading' | 'downloads' | 'extension'

export interface PanelRow {
  /** A store's own id for the thing: a bookmark node, a history entry, a download. */
  id: string
  kind: 'item' | 'folder' | 'header'
  title: string
  /** The second line: a host, or a download's state. */
  sub?: string
  /** The trailing text, already worded. A time is `at`: the page words it in the person's own clock. */
  meta?: string
  /** When the page was last visited, in ms: the page groups rows by day and words the time. */
  at?: number
  /** A `data:` URL main has already vetted; null shows the generic globe. */
  favicon?: string | null
  /** Nesting depth of a tree row. */
  level?: number
  expanded?: boolean
  /** 0 to 1 for a download in progress; null while its size is unknown. Absent when there is no bar. */
  progress?: number | null
}

export interface PanelViewDef {
  readonly id: string
  readonly title: string
  readonly icon: PanelIcon
  readonly searchLabel: string
  /** What a search that finds nothing says it found none of: `No <things> match "x".` */
  readonly things: string
  readonly empty: string
  /** The empty text of a private window, when it differs. */
  readonly emptyPrivate?: string
  /** A link under the list to the full page for this view. */
  readonly page?: { readonly label: string, readonly id: InternalPageId }
  /** The rows for a query; `open` holds the ids of the tree folders the page has expanded. */
  rows: (ctx: WindowContext, query: string, open: ReadonlySet<string>) => PanelRow[]
  /** The address a row opens, from the store; null for a row that opens nothing. */
  resolve?: (ctx: WindowContext, id: string) => string | null
  /** Runs after a row opened a page. */
  opened?: (ctx: WindowContext, id: string) => void
  /** What a click does for a row that is not an address (a download opens its file). */
  activate?: (ctx: WindowContext, id: string) => void
  /** Removes the thing a row stands for; absent when this view never deletes. */
  remove?: (ctx: WindowContext, id: string) => void
  /** Calls `changed` whenever the store behind the rows changes; returns the stop. */
  watch?: (ctx: WindowContext, changed: () => void) => () => void
}

/** The host of an address, for a row's second line; empty for an address that has none. */
export function hostOf (url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.hostname === '' ? parsed.protocol.replace(/:$/, '') : parsed.hostname
  } catch {
    return ''
  }
}

/** Whether a row's text holds the query, ignoring case. A blank query holds everything. */
export function holds (query: string, ...texts: string[]): boolean {
  const needle = query.trim().toLowerCase()
  return needle === '' || texts.some((text) => text.toLowerCase().includes(needle))
}
