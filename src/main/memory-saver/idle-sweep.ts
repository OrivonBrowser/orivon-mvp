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
  /** Whether the computer is short of memory now. A reading that throws counts as not short. */
  memoryLow: () => boolean
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

/** Under memory pressure a tab out of front this long may sleep before its wait is over. */
export const PRESSURE_MIN_IDLE_MS = 5 * 60_000
/** The most tabs one pass puts to sleep because memory is short. */
export const PRESSURE_SLEEPS_PER_PASS = 3

function memoryShort (deps: SweepDeps): boolean {
  try {
    return deps.memoryLow()
  } catch {
    return false
  }
}

/** One pass over every window: the tab in front is stamped, and each other tab idle for longer than the wait goes to
 * sleep, one at a time. A tab never seen in front is stamped now, so it is measured from the first pass that saw it.
 * While memory is short, the least recently used tabs that left the front at least `PRESSURE_MIN_IDLE_MS` ago follow,
 * `PRESSURE_SLEEPS_PER_PASS` at most, whatever the wait. Returns the ids put to sleep. */
export async function sweepIdleTabs (deps: SweepDeps): Promise<string[]> {
  const slept: string[] = []
  const now = deps.now()
  const settings = deps.settings()
  const delay = delayFor(settings, deps.onBattery())
  const asked = new Set<string>()
  const waiting: Array<{ tabs: TabManager, id: string, lastActiveAt: number }> = []
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
      if (delay === null || !dueToSleep(record.lastActiveAt, now, delay)) {
        if (now - record.lastActiveAt >= PRESSURE_MIN_IDLE_MS) waiting.push({ tabs, id, lastActiveAt: record.lastActiveAt })
        continue
      }
      asked.add(id)
      if (await deps.sleep(tabs, id)) slept.push(id)
    }
  }
  if (!settings.memorySaver || waiting.length === 0 || !memoryShort(deps)) return slept
  let relieved = 0
  for (const { tabs, id } of waiting.sort((a, b) => a.lastActiveAt - b.lastActiveAt)) {
    if (relieved >= PRESSURE_SLEEPS_PER_PASS) break
    if (asked.has(id)) continue
    if (await deps.sleep(tabs, id)) { slept.push(id); relieved += 1 }
  }
  return slept
}
