// Brings one source's bookmarks and history into the stores, and says what happened. Everything it reads
// comes from another program's files: the readers bound it, and every address goes through the stores'
// own checks on the way in. It never writes outside the two stores.
import { join } from 'node:path'
import { MAX_IMPORTED_PAGES } from '../history/history-import.js'
import type { HistoryImportRow } from '../history/history-store.js'
import { placeBookmarks } from './bookmark-merge.js'
import type { BookmarkSink, Placement } from './bookmark-merge.js'
import { parseBookmarksHtml } from './bookmarks-html-import.js'
import { parseChromiumBookmarks } from './chromium-bookmarks.js'
import { readChromiumHistory } from './chromium-history.js'
import { readFirefoxBookmarks, readFirefoxHistory } from './firefox-places.js'
import type { ImportFs } from './import-fs.js'
import { BROWSER_NAMES, ImportError, MAX_IMPORT_BYTES } from './import-types.js'
import type { ImportResult, ImportSource, SourceBookmarks } from './import-types.js'
import { withDatabaseCopy } from './sqlite-copy.js'

export interface ImportDeps {
  readonly fs: ImportFs
  readonly bookmarks: BookmarkSink
  readonly history: { importPages: (rows: readonly HistoryImportRow[]) => number }
  readonly now: () => number
  /** How many days of history are kept; null keeps all of it. */
  readonly retentionDays: () => number | null
  /** Told which part is running, for the page's progress line. */
  readonly progress: (phase: 'bookmarks' | 'history') => void
  /** Where a database is copied to be read; the operating system's temporary directory when absent. */
  readonly tempDir?: string
}

export interface ImportWhat {
  readonly bookmarks: boolean
  readonly history: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000

async function readSourceBookmarks (source: ImportSource, deps: ImportDeps): Promise<SourceBookmarks> {
  if (source.family === 'firefox') return await withDatabaseCopy(join(source.dir, 'places.sqlite'), readFirefoxBookmarks, deps.tempDir)
  const file = join(source.dir, 'Bookmarks')
  const text = await deps.fs.readText(file, MAX_IMPORT_BYTES)
  if (text === undefined) {
    if (await deps.fs.isFile(file)) throw new ImportError('unreadable')
    return { bar: [], other: [] }
  }
  try {
    return parseChromiumBookmarks(text)
  } catch (error) {
    throw error instanceof ImportError && error.reason === 'format' ? new ImportError('unreadable') : error
  }
}

async function readSourceHistory (source: ImportSource, deps: ImportDeps): Promise<HistoryImportRow[]> {
  const days = deps.retentionDays()
  const options = { limit: MAX_IMPORTED_PAGES, sinceMs: days === null ? 0 : deps.now() - days * DAY_MS }
  if (source.family === 'firefox') return await withDatabaseCopy(join(source.dir, 'places.sqlite'), (db) => readFirefoxHistory(db, options), deps.tempDir)
  const file = join(source.dir, 'History')
  if (!await deps.fs.isFile(file)) return []
  return await withDatabaseCopy(file, (db) => readChromiumHistory(db, options), deps.tempDir)
}

const reasonOf = (error: unknown): 'locked' | 'unreadable' | 'format' => error instanceof ImportError ? error.reason : 'unreadable'

function resultOf (placement: Placement | undefined, pages: number, error?: 'locked' | 'unreadable' | 'format'): ImportResult {
  const imported = placement?.imported ?? 0
  return {
    bookmarks: imported,
    pages,
    skipped: placement === undefined ? 0 : Math.max(placement.total - placement.known - imported, 0),
    known: placement?.known ?? 0,
    target: placement?.target ?? 'bar',
    ...(placement?.folderTitle === undefined ? {} : { folderTitle: placement.folderTitle }),
    ...(error === undefined ? {} : { error })
  }
}

/** Imports what `what` asks of one profile. Bookmarks go first: a history that cannot be read afterwards leaves them in place. */
export async function runImport (source: ImportSource, what: ImportWhat, deps: ImportDeps): Promise<ImportResult> {
  let placement: Placement | undefined
  let pages = 0
  try {
    if (what.bookmarks) {
      deps.progress('bookmarks')
      placement = placeBookmarks(deps.bookmarks, await readSourceBookmarks(source, deps), `Imported from ${BROWSER_NAMES[source.browser]}`)
    }
  } catch (error) {
    return resultOf(undefined, 0, reasonOf(error))
  }
  try {
    if (what.history) {
      deps.progress('history')
      pages = deps.history.importPages(await readSourceHistory(source, deps))
    }
  } catch (error) {
    return resultOf(placement, 0, reasonOf(error))
  }
  return resultOf(placement, pages)
}

/** Imports a bookmarks HTML file's text. */
export function runHtmlImport (text: string, deps: Pick<ImportDeps, 'bookmarks' | 'progress'>): ImportResult {
  try {
    deps.progress('bookmarks')
    return resultOf(placeBookmarks(deps.bookmarks, parseBookmarksHtml(text), 'Imported from HTML file'), 0)
  } catch (error) {
    return resultOf(undefined, 0, reasonOf(error))
  }
}
