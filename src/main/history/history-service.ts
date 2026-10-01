// History as the rest of the shell uses it: the store, the person's two
// settings about it, and what those settings mean for what is kept. The store
// holds what happened; this decides whether to write it down and how long to
// keep it.
import type { SettingsStore } from '../settings/settings-store.js'
import { MAX_IMPORTED_PAGES, selectImportRows } from './history-import.js'
import type { HistoryEntry, HistoryImportRow, HistoryQuery, HistoryStore, HistorySuggestion } from './history-store.js'

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_OFFERED_ICONS = 500

export interface HistoryStatus {
  /** Whether new visits are being remembered. */
  readonly remembering: boolean
  /** Set when the history file could not be used and nothing is being kept. */
  readonly problem: string | null
  readonly count: number
}

/**
 * What changed, for a listener that does not care about the entries
 * themselves, only about `status()`'s own `count` -- Settings' Privacy
 * section shows a count, never a title. `'titled'` is the one call that never
 * changes it (an existing row's title, in place); everything else can.
 */
export type HistoryChange = 'titled' | 'entries'

export class HistoryService {
  private readonly listeners = new Set<(change: HistoryChange) => void>()
  /** The last icon offered per host. Anything that forgets pages forgets this too, so a site visited again gets its icon back. */
  private readonly offeredIcons = new Map<string, string>()

  constructor (
    private readonly store: HistoryStore,
    private readonly settings: Pick<SettingsStore, 'get' | 'onChange'>,
    private readonly problem: string | null = null,
    private readonly now: () => number = Date.now
  ) {
    settings.onChange(({ key }) => { if (key === 'history.retentionDays') this.prune() })
  }

  get remembering (): boolean {
    return this.settings.get('history.remember')
  }

  status (): HistoryStatus {
    return { remembering: this.remembering, problem: this.problem, count: this.store.count() }
  }

  visit (url: string, title: string): void {
    if (!this.remembering) return
    this.store.record(url, title, this.now())
    this.notify('entries')
  }

  titled (url: string, title: string): void {
    if (!this.remembering) return
    this.store.setTitle(url, title)
    this.notify('titled')
  }

  list (query?: HistoryQuery): HistoryEntry[] {
    return this.store.list(query)
  }

  /** Like `list`, in `query.order` from `query.offset`, each entry with its `favicon`. */
  listOrdered (query?: HistoryQuery): HistoryEntry[] {
    return this.store.listOrdered(query)
  }

  suggest (text: string, limit: number): HistorySuggestion[] {
    return this.store.suggest(text, limit)
  }

  /** Nothing is written down while history is off, a typed address included. */
  markTyped (url: string): void {
    if (!this.remembering) return
    this.store.markTyped(url)
  }

  /** Tabs report their icon on every state push, so an icon already kept is not offered to the store again. */
  setFavicon (host: string, dataUrl: string): void {
    if (!this.remembering || this.offeredIcons.get(host) === dataUrl) return
    // Called from inside a state push: a store that fails must not end it, and an icon it did not take is offered again.
    try {
      this.store.setFavicon(host, dataUrl)
    } catch (error) {
      console.error('[orivon] history could not be written:', error)
      return
    }
    if (this.offeredIcons.size >= MAX_OFFERED_ICONS) this.offeredIcons.clear()
    this.offeredIcons.set(host, dataUrl)
  }

  faviconsFor (hosts: readonly string[]): Record<string, string> {
    return this.store.faviconsFor(hosts)
  }

  pruneFavicons (): void {
    this.store.pruneFavicons()
    this.offeredIcons.clear()
  }

  pagesByIds (ids: readonly number[]): HistoryEntry[] {
    return this.store.pagesByIds(ids)
  }

  /** Pages the person chose to bring in, kept newest first within the retention; nothing while history is off. */
  importPages (rows: readonly HistoryImportRow[]): number {
    if (!this.remembering) return 0
    const days = this.settings.get('history.retentionDays')
    const kept = selectImportRows(rows, { now: this.now(), retentionDays: days === 'forever' ? null : Number(days), limit: MAX_IMPORTED_PAGES })
    const added = this.store.importPages(kept)
    if (added > 0) this.notify('entries')
    return added
  }

  remove (id: number): void {
    this.store.remove(id)
    this.offeredIcons.clear()
    this.notify('entries')
  }

  removeMany (ids: readonly number[]): void {
    this.store.removeMany(ids)
    this.offeredIcons.clear()
    this.notify('entries')
  }

  removeRange (from: number, to: number): void {
    this.store.removeRange(from, to)
    this.offeredIcons.clear()
    this.notify('entries')
  }

  clear (): void {
    this.store.clear()
    this.offeredIcons.clear()
    this.notify('entries')
  }

  /** Forgets what is older than the person chose to keep. Run at start and when the choice changes. */
  prune (): void {
    const days = this.settings.get('history.retentionDays')
    if (days === 'forever') return
    // Run at start, where a failure would end the browser on every start and leave no way into Settings to clear it.
    try {
      this.store.removeRange(0, this.now() - Number(days) * DAY_MS)
      this.offeredIcons.clear()
      this.notify('entries')
    } catch (error) {
      console.error('[orivon] history could not be pruned:', error)
    }
  }

  /** The History page, and Settings' Privacy section, both read `status()`/`list()` again on this. Returns the unsubscribe. */
  onChange (listener: (change: HistoryChange) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify (change: HistoryChange): void {
    for (const listener of this.listeners) listener(change)
  }

  flush (): void {
    this.store.flush()
  }

  close (): void {
    this.store.close()
  }
}
