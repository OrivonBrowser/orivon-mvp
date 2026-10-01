// A tab brought back from the last session starts asleep when the memory saver is on, so a window of forty tabs does
// not load forty pages at once. The tab is made as usual and then put to sleep before its page has done anything.
import type { TabSnapshot } from '../session-restore/tab-snapshot.js'
import type { TabManager } from '../shell/tabs.js'
import { gatherFacts, realEnv } from './sleep-facts.js'
import type { SleepEnv } from './sleep-facts.js'
import { canSleep } from './sleep-rules.js'
import { putToSleep } from './sleep-tab.js'

/** Puts the tab `id`, just opened from `snapshot`, to sleep. False when it must stay awake: the memory saver is off,
 * or any rule that holds for a tab holds for this one (the tab in front, a pinned tab, a site that never sleeps).
 * Only the address and title of each entry are kept: the snapshot holds no page state, so the page comes back
 * at its top. */
export function restoreAsleep (tabs: TabManager, id: string, snapshot: TabSnapshot, env: SleepEnv = realEnv): boolean {
  const record = tabs.record(id)
  if (record === undefined || record.sleeping != null) return false
  if (record.host.services?.settings.get('performance.memorySaver') !== true) return false
  const facts = gatherFacts(tabs, id, env, snapshot.url)
  // A page still loading is the page this is about to drop.
  if (facts === null || !canSleep({ ...facts, unsaved: false, loading: false }).ok || snapshot.internal !== undefined) return false
  const entries = snapshot.entries === undefined || snapshot.index === undefined
    ? [{ url: snapshot.url, title: snapshot.title }]
    : snapshot.entries.map(({ url, title }) => ({ url, title }))
  return putToSleep(tabs, id, record, { url: snapshot.url, title: snapshot.title, favicon: null, entries, index: snapshot.index ?? 0, at: env.now() })
}
