// Sending a whole group to a window of its own: its tabs leave one by one (each leaves its group on the way out) and
// the new window makes the group again, with the same name and colour, open.
import { cascadeFrom } from '../shell/window-options.js'
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
      const moved: string[] = []
      for (const id of members) {
        const record = entry.tabs.takeTab(id)
        if (record === null) continue
        tabs.giveTab(id, record)
        moved.push(id)
      }
      if (moved.length === 0) { tabs.createTab(); return }
      const groups = groupsFor(tabs)
      const made = groups.create(group.color, group.title)
      for (const id of moved) {
        const record = tabs.record(id)
        if (record !== undefined) record.groupId = made
      }
      tabs.changed()
    }
  })
  return true
}
