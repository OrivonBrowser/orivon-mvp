// Sending a whole group to a window of its own: its tabs leave one by one (each leaves its group on the way out) and
// the new window makes the group again, with the same name and colour, open.
import { cascadeFrom } from '../shell/window-options.js'
import type { TabRecord } from '../shell/tab-types.js'
import type { WindowContext } from '../shell/window-context.js'
import { groupsFor } from './groups-model.js'
import { membersOf } from './groups-runner.js'

/** True when a window was opened. A group holding every tab of its window stays: moving it would only move the window. */
export function moveGroupToNewWindow (ctx: WindowContext, groupId: string): boolean {
  const { window: entry, services } = ctx
  const group = groupsFor(entry.tabs).get(groupId)
  const members = membersOf(entry.tabs, groupId)
  if (group === undefined || members.length === 0 || entry.tabs.tabCount <= members.length || entry.shortcutsSuspended()) return false
  services.commands.openWindow({
    place: cascadeFrom(entry.window.getBounds()),
    instant: true,
    first: (tabs) => {
      // Only the tab put in front wakes. The one in front here leaves last, so the tab this window falls back to is never
      // another member on its way out.
      const front = entry.tabs.getState().activeTabId
      const taken = new Map<string, TabRecord>()
      for (const id of [...members.filter((member) => member !== front), ...members.filter((member) => member === front)]) {
        const record = entry.tabs.takeTab(id)
        if (record !== null) taken.set(id, record)
      }
      const moved = members.filter((id) => taken.has(id))
      for (const id of moved) tabs.giveTab(id, taken.get(id) as TabRecord, undefined, false)
      const shown = front !== null && taken.has(front) ? front : moved[0]
      if (shown === undefined) { tabs.createTab(); return }
      const groups = groupsFor(tabs)
      const made = groups.create(group.color, group.title)
      for (const id of moved) {
        const record = tabs.record(id)
        if (record !== undefined) record.groupId = made
      }
      tabs.activateTab(shown)
    }
  })
  return true
}
