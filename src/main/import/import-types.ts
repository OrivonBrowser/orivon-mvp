// The shapes shared by everything that reads another browser's files and by the domain that asks for it.
import type { BookmarkTreeInput } from '../browsing/bookmark-types.js'

export type BrowserKey = 'chrome' | 'chromium' | 'edge' | 'brave' | 'firefox'
export type ImportFamily = 'chromium' | 'firefox'

export const BROWSER_NAMES: Readonly<Record<BrowserKey, string>> = {
  chrome: 'Chrome',
  chromium: 'Chromium',
  edge: 'Edge',
  brave: 'Brave',
  firefox: 'Firefox'
}

/** Where a browser keeps its profiles on this computer: the directory that holds `Local State` or `profiles.ini`. */
export interface BrowserRoot {
  readonly browser: BrowserKey
  readonly family: ImportFamily
  readonly root: string
}

/** One profile of another browser that can be read. */
export interface ImportSource {
  readonly browser: BrowserKey
  readonly family: ImportFamily
  /** The profile's name as that browser shows it. */
  readonly profile: string
  /** The profile's directory, inside its root. */
  readonly dir: string
}

/** Why an import could not finish. `private` is the runtime refusing, never a file. */
export type ImportErrorReason = 'locked' | 'unreadable' | 'format'

export class ImportError extends Error {
  constructor (readonly reason: ImportErrorReason) {
    super(`import failed: ${reason}`)
  }
}

/** What an import did. A failure after some work keeps the counts of the work that was done. */
export interface ImportResult {
  /** Bookmarks added. */
  readonly bookmarks: number
  /** Pages of history added or merged. */
  readonly pages: number
  /** Bookmarks left out because their address cannot be opened in Orivon, or because a limit was reached. */
  readonly skipped: number
  /** Bookmarks left out because they were already there. */
  readonly known: number
  /** `bar`: they went onto the bar and into Other bookmarks as they were. `folder`: into one folder on the bar. */
  readonly target: 'bar' | 'folder'
  readonly folderTitle?: string
  readonly error?: ImportErrorReason
}

/** The bookmarks of one source, by where they belong. */
export interface SourceBookmarks {
  readonly bar: BookmarkTreeInput[]
  readonly other: BookmarkTreeInput[]
}

/** Most nodes one source may hold; past it the reader stops. */
export const MAX_IMPORT_NODES = 20_000
/** Largest file read whole: a bookmarks file or a bookmarks HTML file. */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024
/** Folders deeper than this are flattened into the deepest one, leaving room for the folders an import adds above. */
export const MAX_IMPORT_LEVELS = 9
/** The longest title kept. */
export const MAX_IMPORT_TITLE = 512
