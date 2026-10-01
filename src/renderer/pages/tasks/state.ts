// What the task manager knows: the latest reading of the processes, refreshed
// every two seconds while the page can be seen, and which row is selected.
// It never touches the DOM; view.ts draws what it holds.
import { internalBridge } from '../shared/bridge.js'
import type { OrivonInternal } from '../shared/bridge.js'
import { DEFAULT_SORT, displayRows, nextSort } from './sort.js'
import type { DisplayRow, SortKey, SortState, Task } from './sort.js'

export interface Totals {
  readonly memoryKb: number
  readonly cpu: number | null
}

export const POLL_MS = 2_000

/** How long a refusal stays on screen. */
const NOTICE_MS = 4_000

export class TasksState {
  tasks: readonly Task[] = []
  totals: Totals = { memoryKb: 0, cpu: null }
  loaded = false
  failed = false
  sort: SortState = DEFAULT_SORT
  selectedKey: string | null = null
  notice: string | null = null
  private timer: ReturnType<typeof setInterval> | undefined
  private inFlight = false
  private noticeTimer: ReturnType<typeof setTimeout> | undefined
  private readonly listeners = new Set<() => void>()

  constructor (private readonly bridge: OrivonInternal = internalBridge()) {}

  onChange (listener: () => void): void {
    this.listeners.add(listener)
  }

  private changed (): void {
    for (const listener of this.listeners) listener()
  }

  rows (): DisplayRow[] {
    return displayRows(this.tasks, this.sort)
  }

  selected (): DisplayRow | undefined {
    return this.rows().find((row) => row.key === this.selectedKey)
  }

  select (key: string | null): void {
    if (this.selectedKey === key) return
    this.selectedKey = key
    this.changed()
  }

  sortBy (key: SortKey): void {
    this.sort = nextSort(this.sort, key)
    this.changed()
  }

  /** Polls until `stop`, and reads again at once when asked to. */
  start (): void {
    this.stop()
    void this.refresh()
    this.timer = setInterval(() => { void this.refresh() }, POLL_MS)
  }

  stop (): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  async refresh (): Promise<void> {
    if (this.inFlight) return
    this.inFlight = true
    try {
      const reply = await this.bridge.request('tasks', { type: 'list' }) as { rows?: readonly Task[], totals?: Totals } | undefined
      if (reply?.rows === undefined || reply.totals === undefined) throw new Error('no list')
      this.tasks = reply.rows
      this.totals = reply.totals
      this.failed = false
      if (this.selectedKey !== null && this.selected() === undefined) this.selectedKey = null
    } catch {
      this.failed = true
    } finally {
      this.inFlight = false
      this.loaded = true
      this.changed()
    }
  }

  /** Ends the selected row's process, when it may be. */
  async endSelected (): Promise<void> {
    const row = this.selected()
    if (row === undefined || !row.endable) return
    const reply = await this.bridge.request('tasks', { type: 'end', pid: row.pid }) as { ok?: boolean } | undefined
    if (reply?.ok !== true) this.say('That process could not be ended. It may already have closed.')
    await this.refresh()
  }

  /** Takes the person to the tab a row shows. */
  async goTo (row: DisplayRow): Promise<void> {
    if (row.tabId === undefined) return
    const reply = await this.bridge.request('tasks', { type: 'focus', tabId: row.tabId }) as { ok?: boolean } | undefined
    if (reply?.ok !== true) this.say('That tab has closed.')
  }

  private say (text: string): void {
    this.notice = text
    if (this.noticeTimer !== undefined) clearTimeout(this.noticeTimer)
    this.noticeTimer = setTimeout(() => {
      this.notice = null
      this.changed()
    }, NOTICE_MS)
    this.changed()
  }
}
