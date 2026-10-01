// The windows a tab's current page tried to open and was refused, for the
// address bar's chip and the bubble under it. Kept per tab and forgotten when
// the tab loads another document, so a blocked pop-up on one page never marks
// the next. No `electron` import: a tab is used only through `on`.

/** The one event of a tab's webContents this reads, typed as Electron emits it. */
export interface NavigatingTab {
  on: (event: 'did-navigate', listener: () => void) => unknown
}

/** The most addresses kept per page; a page that opens windows in a loop cannot grow it. */
export const MAX_BLOCKED_PER_PAGE = 50

export type PopupBlocksListener = (tab: object) => void

export class PopupBlocks<T extends NavigatingTab & object> {
  private readonly pages = new WeakMap<T, string[]>()
  private readonly listeners = new Set<PopupBlocksListener>()

  /** Records an address the page tried to open; the oldest is forgotten past the cap. */
  add (tab: T, url: string): void {
    let urls = this.pages.get(tab)
    if (urls === undefined) {
      urls = []
      this.pages.set(tab, urls)
      // Main frame only, and not for in-page (hash or history) navigations: exactly a new page load.
      tab.on('did-navigate', () => { this.clear(tab) })
    }
    urls.push(url)
    if (urls.length > MAX_BLOCKED_PER_PAGE) urls.shift()
    this.changed(tab)
  }

  /** Newest first. */
  list (tab: T): readonly string[] {
    return [...(this.pages.get(tab) ?? [])].reverse()
  }

  count (tab: T): number {
    return this.pages.get(tab)?.length ?? 0
  }

  /** Called for any change to any tab; `tab` is the one that changed. Returns the removal. */
  onChange (listener: PopupBlocksListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private clear (tab: T): void {
    const urls = this.pages.get(tab)
    if (urls === undefined || urls.length === 0) return
    urls.length = 0
    this.changed(tab)
  }

  private changed (tab: T): void {
    for (const listener of [...this.listeners]) {
      try { listener(tab) } catch (error) { console.error('[popup-blocks] a listener failed:', error) }
    }
  }
}
