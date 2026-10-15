// The files a tab's page asked the verifier for that it could not give, for the chip in the address bar that tells the
// person the page is not whole. Kept per tab and forgotten when the tab loads another document, so one page's missing
// stylesheet never marks the next. No `electron` import: a tab is used only through `on`.

/** The one event of a tab's webContents this reads, typed as Electron emits it. */
export interface NavigatingTab {
  on: (event: 'did-navigate', listener: () => void) => unknown
}

/** The most addresses kept per page; a page that asks for files in a loop cannot grow it. */
export const MAX_FAILED_PER_PAGE = 100

export type FailedFilesListener = (tab: object) => void

export class FailedFiles<T extends NavigatingTab & object> {
  private readonly pages = new WeakMap<T, Set<string>>()
  private readonly listeners = new Set<FailedFilesListener>()

  /** Records a file the page asked for and did not get. The same file failing again (a retry by the page) counts once. */
  add (tab: T, url: string): void {
    let urls = this.pages.get(tab)
    if (urls === undefined) {
      urls = new Set()
      this.pages.set(tab, urls)
      // Main frame only, and not for in-page (hash or history) navigations: exactly a new page load.
      tab.on('did-navigate', () => { this.clear(tab) })
    }
    if (urls.has(url) || urls.size >= MAX_FAILED_PER_PAGE) return
    urls.add(url)
    this.changed(tab)
  }

  /** A file that was asked for again and came: no longer missing. */
  arrived (tab: T, url: string): void {
    if (this.pages.get(tab)?.delete(url) === true) this.changed(tab)
  }

  count (tab: T): number {
    return this.pages.get(tab)?.size ?? 0
  }

  /** Called for any change to any tab; `tab` is the one that changed. Returns the removal. */
  onChange (listener: FailedFilesListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private clear (tab: T): void {
    const urls = this.pages.get(tab)
    if (urls === undefined || urls.size === 0) return
    urls.clear()
    this.changed(tab)
  }

  private changed (tab: T): void {
    for (const listener of [...this.listeners]) {
      try { listener(tab) } catch (error) { console.error('[failed-files] a listener failed:', error) }
    }
  }
}

/** The files of a page: not its document or a frame's, whose failure shows as an error page of its own. */
const FILE_TYPES: ReadonlySet<string> = new Set(['stylesheet', 'script', 'image', 'font', 'media', 'xhr', 'object', 'other'])

/** What `installFileFailureWatch` hears of a finished request. */
export interface CompletedFile {
  readonly url: string
  readonly resourceType: string
  readonly statusCode: number
  readonly webContentsId?: number | undefined
}

/**
 * Notes, in `failedFiles`, a file of a page that the verifier answered with a failure (a 5xx: it could not read or verify
 * the file now), and forgets it when the same file later arrives, so the chip that tells the person the page is not whole
 * is there exactly while a file is missing. A 404 is a file the site does not have, and is not a failure of loading.
 */
export function noteCompletedFile<T extends NavigatingTab & object> (record: FailedFiles<T>, details: CompletedFile, tabOf: (id: number) => T | undefined): void {
  if (!FILE_TYPES.has(details.resourceType) || details.webContentsId === undefined) return
  const tab = tabOf(details.webContentsId)
  if (tab === undefined) return
  if (details.statusCode >= 500) record.add(tab, details.url)
  else record.arrived(tab, details.url)
}

