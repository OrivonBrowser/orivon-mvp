// What runs for the life of the process: wakes a tab when it comes to the front, and sweeps for idle ones. No
// `electron` import, so the timer and the power source are tested with fakes.
import type { WebContents } from 'electron'
import type { TabLifecycle } from '../shell/tab-lifecycle.js'
import type { TabManager } from '../shell/tabs.js'
import { sweepIdleTabs, stampInFront } from './idle-sweep.js'
import type { SweepDeps, SweepWindow } from './idle-sweep.js'
import { wakeTab } from './sleep-tab.js'

/** How often idle tabs are looked for. */
export const SWEEP_EVERY_MS = 60_000

export interface MemorySaverDeps extends SweepDeps {
  lifecycle: TabLifecycle
  /** The window and tab a tab's page belongs to. */
  findTab: (contents: WebContents) => { window: SweepWindow, tabId: string } | null
  /** Tells the caller when a setting that decides sleeping changes. */
  onSettingChange: (listener: () => void) => () => void
  /** The timer; `unref`ed so it never keeps the process alive. */
  every: (run: () => void, ms: number) => { stop: () => void }
}

export interface MemorySaver {
  /** One pass now, as the timer would run it. */
  sweep: () => Promise<string[]>
  stop: () => void
}

export function startMemorySaver (deps: MemorySaverDeps): MemorySaver {
  /** The tab in front of each window, so the one it replaces can be stamped as having just left. */
  const front = new WeakMap<TabManager, string>()
  let running: Promise<string[]> | null = null

  const sweep = async (): Promise<string[]> => {
    // A pass still going is the pass: a second would sleep the same tabs twice.
    running ??= sweepIdleTabs(deps).finally(() => { running = null })
    return await running
  }
  const sweepQuietly = (): void => { void sweep().catch((error: unknown) => { console.error('[memory-saver] a sweep failed:', error) }) }

  const unsubscribe = deps.lifecycle.subscribe({
    tabActivated: (contents) => {
      const found = deps.findTab(contents)
      if (found === null) return
      const { tabs } = found.window
      const now = deps.now()
      const left = front.get(tabs)
      if (left !== undefined && left !== found.tabId) stampInFront(tabs, left, now)
      front.set(tabs, found.tabId)
      stampInFront(tabs, found.tabId, now)
      // The tab beside it in a split is on screen too.
      const partner = tabs.splits.groups.partnerOf(found.tabId)
      for (const id of partner === null ? [found.tabId] : [found.tabId, partner]) wakeTab(tabs, id)
    }
  })
  const timer = deps.every(sweepQuietly, SWEEP_EVERY_MS)
  const unwatch = deps.onSettingChange(sweepQuietly)
  return { sweep, stop: () => { unsubscribe(); timer.stop(); unwatch() } }
}
