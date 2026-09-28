// History as the rest of the shell uses it: the store, the person's two
// settings about it, and what those settings mean for what is kept. The store
// holds what happened; this decides whether to write it down and how long to
// keep it.
import type { SettingsStore } from '../settings/settings-store.js'
import type { HistoryEntry, HistoryQuery, HistoryStore } from './history-store.js'

const DAY_MS = 24 * 60 * 60 * 1000

export interface HistoryStatus {
  /** Whether new visits are being remembered. */
  readonly remembering: boolean
  /** Set when the history file could not be used and nothing is being kept. */
  readonly problem: string | null
  readonly count: number
}

export class HistoryService {
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
    if (this.remembering) this.store.record(url, title, this.now())
  }

  titled (url: string, title: string): void {
    if (this.remembering) this.store.setTitle(url, title)
  }

  list (query?: HistoryQuery): HistoryEntry[] {
    return this.store.list(query)
  }

  remove (id: number): void {
    this.store.remove(id)
  }

  removeRange (from: number, to: number): void {
    this.store.removeRange(from, to)
  }

  clear (): void {
    this.store.clear()
  }

  /** Forgets what is older than the person chose to keep. Run at start and when the choice changes. */
  prune (): void {
    const days = this.settings.get('history.retentionDays')
    if (days === 'forever') return
    // Run at start, where a failure would end the browser on every start and leave no way into Settings to clear it.
    try {
      this.store.removeRange(0, this.now() - Number(days) * DAY_MS)
    } catch (error) {
      console.error('[orivon] history could not be pruned:', error)
    }
  }

  flush (): void {
    this.store.flush()
  }

  close (): void {
    this.store.close()
  }
}
