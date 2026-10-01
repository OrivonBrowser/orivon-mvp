// What was asked of the person, and what they (or a stored answer) decided,
// on the page a tab is showing now. The address bar's chip reads it, and so
// does the bubble under the chip. Kept per tab and forgotten when the tab
// loads another document, so a blocked camera on one page never marks the
// next. No `electron` import: a tab is used only through `on`.
import type { WebContents } from 'electron'
import { SITE_KINDS, type SiteKind } from './kinds.js'

export type AccessState = 'allowed' | 'blocked'

export interface AccessEntry { readonly kind: SiteKind, readonly state: AccessState }

/** The one event of a tab's webContents this reads, typed as Electron emits it. */
export interface NavigatingTab {
  on: (event: 'did-navigate', listener: () => void) => unknown
}

interface Document {
  /** Counts the documents the tab has loaded, so an answer can tell the page it was asked on from the one that is there now. */
  loads: number
  origin: string
  kinds: Map<SiteKind, AccessState>
  /** Kinds the person closed the prompt on: not asked again until the page loads again. */
  dismissed: Set<SiteKind>
}

export type PageAccessListener = (tab: object) => void

const ORDER: readonly SiteKind[] = SITE_KINDS.map((kind) => kind.id)

export class PageAccess<T extends NavigatingTab & object> {
  private readonly documents = new WeakMap<T, Document>()
  private readonly listeners = new Set<PageAccessListener>()

  /** The document of `tab`, started for `origin`: a record of another origin means the page changed without a navigation event reaching here, so it starts over. */
  private documentOf (tab: T, origin: string): Document {
    let document = this.documents.get(tab)
    if (document === undefined) {
      document = { loads: 0, origin, kinds: new Map(), dismissed: new Set() }
      this.documents.set(tab, document)
      // Main frame only, and not for in-page (hash or history) navigations: exactly a new page load.
      tab.on('did-navigate', () => { this.clear(tab) })
    } else if (document.origin !== origin) {
      document.origin = origin
      document.kinds.clear()
      document.dismissed.clear()
    }
    return document
  }

  /** Records that `kind` was allowed or blocked on the page at `origin`. */
  note (tab: T, origin: string, kind: SiteKind, state: AccessState): void {
    const document = this.documentOf(tab, origin)
    if (document.kinds.get(kind) === state) return
    document.kinds.set(kind, state)
    document.dismissed.delete(kind)
    this.changed(tab)
  }

  /** The prompt was closed without an answer: the page may not ask for these again until it loads again. */
  dismiss (tab: T, origin: string, kinds: readonly SiteKind[]): void {
    const document = this.documentOf(tab, origin)
    for (const kind of kinds) document.dismissed.add(kind)
  }

  wasDismissed (tab: T, origin: string, kind: SiteKind): boolean {
    const document = this.documents.get(tab)
    return document !== undefined && document.origin === origin && document.dismissed.has(kind)
  }

  /** Changes whenever the tab loads another document; a question asked now and answered at a different value was about a page that is gone. */
  loads (tab: T, origin: string): number {
    return this.documentOf(tab, origin).loads
  }

  /** What was decided on this page, in the order the kinds are listed. */
  entries (tab: T): AccessEntry[] {
    const document = this.documents.get(tab)
    if (document === undefined) return []
    return ORDER.filter((kind) => document.kinds.has(kind)).map((kind) => ({ kind, state: document.kinds.get(kind) as AccessState }))
  }

  /** The origin the record is about, or null when nothing was decided on this page. */
  originOf (tab: T): string | null {
    const document = this.documents.get(tab)
    return document === undefined || document.kinds.size === 0 ? null : document.origin
  }

  /** Called for any change to any tab; `tab` is the one that changed. Returns the removal. */
  onChange (listener: PageAccessListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private clear (tab: T): void {
    const document = this.documents.get(tab)
    if (document === undefined) return
    const hadEntries = document.kinds.size > 0
    document.loads += 1
    document.kinds.clear()
    document.dismissed.clear()
    if (hadEntries) this.changed(tab)
  }

  private changed (tab: T): void {
    for (const listener of [...this.listeners]) {
      try { listener(tab) } catch (error) { console.error('[page-access] a listener failed:', error) }
    }
  }
}

/** The one record of this process: every window's tabs, read by the chip's state and the review bubble. */
export const pageAccess = new PageAccess<WebContents>()
