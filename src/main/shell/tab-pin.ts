// Pinning a tab: it keeps the strip's start, in the pinned run, and a pair of split tabs never holds one.
import type { TabManager } from './tabs.js'

/** Pins or unpins a tab and moves it to the edge of the pinned run: a pinned tab joins the run's end, an unpinned
 * one the start of what follows it. False when nothing changed, or the tab is in a split (a pair stays side by
 * side, so it is never pinned). */
export function setPinned (tabs: TabManager, id: string, on: boolean): boolean {
  const record = tabs.record(id)
  if (record === undefined || (record.pinned === true) === on) return false
  if (on && tabs.splits.groups.partnerOf(id) !== null) return false
  record.pinned = on
  // A pinned tab is never in a group: pinning leaves it.
  if (on) record.groupId = null
  const rest = tabs.ids().filter((other) => other !== id)
  tabs.moveTab(id, rest.filter((other) => tabs.record(other)?.pinned === true).length)
  tabs.changed()
  return true
}
