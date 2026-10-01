// The once-a-minute pass that puts idle tabs to sleep, and the stamp of when a tab was last in front. No `electron`
// import: the windows, the clock and the sleeping itself come in, so the pass is tested with fakes.
import type { TabManager } from '../shell/tabs.js'
import { delayFor, dueToSleep } from './sleep-rules.js'
import type { SleepSettings } from './sleep-rules.js'

export interface SweepWindow {
  readonly tabs: TabManager
  readonly window: { isDestroyed: () => boolean }
}

export interface SweepDeps {
  windows: () => readonly SweepWindow[]
  settings: () => SleepSettings
  onBattery: () => boolean
  now: () => number
  sleep: (tabs: TabManager, id: string) => Promise<boolean>
}

/** Marks `id`, and the tab beside it in a split, as in front now. */
export function stampInFront (tabs: TabManager, id: string, now: number): void {
  const partner = tabs.splits.groups.partnerOf(id)
  for (const shown of partner === null ? [id] : [id, partner]) {
    const record = tabs.record(shown)
    if (record !== undefined) record.lastActiveAt = now
  }
}

/** One pass over every window: the tab in front is stamped, and each other tab idle for longer than the wait goes to
 * sleep, one at a time. A tab never seen in front is stamped now, so it is measured from the first pass that saw it.
 * Returns the ids put to sleep. */
export async function sweepIdleTabs (deps: SweepDeps): Promise<string[]> {
  const slept: string[] = []
  const now = deps.now()
  const delay = delayFor(deps.settings(), deps.onBattery())
  for (const { tabs, window } of deps.windows()) {
    if (window.isDestroyed()) continue
    const active = tabs.getState().activeTabId
    if (active !== null) stampInFront(tabs, active, now)
    for (const id of tabs.ids()) {
      const record = tabs.record(id)
      if (record === undefined || record.sleeping != null) continue
      if (record.lastActiveAt === undefined) {
        record.lastActiveAt = now
        continue
      }
      if (delay === null || !dueToSleep(record.lastActiveAt, now, delay)) continue
      if (await deps.sleep(tabs, id)) slept.push(id)
    }
  }
  return slept
}
