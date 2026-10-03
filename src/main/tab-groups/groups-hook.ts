// Wires one window's strip to the group rules: the hooks the tab collection calls after a move or a link opening and
// to ask which tabs a collapsed group hides, and the check that runs after every state change.
import type { TabManager } from '../shell/tabs.js'
import type { WindowHook } from '../shell/window-hooks.js'
import { groupsFor } from './groups-model.js'
import { joinOpenerGroup } from './groups-runner.js'
import { reconcile, settleMoved } from './groups-sync.js'

export const tabGroupsHook: WindowHook = {
  name: 'tab-groups',
  opened: ({ window }) => {
    const { tabs } = window
    tabs.afterMove = (id) => { settleMoved(tabs, id) }
    tabs.afterOpen = (id, opener) => { joinOpenerGroup(tabs, id, opener) }
    tabs.hidden = (id) => isHidden(tabs, id)
    tabs.onStateChange(({ activeTabId }) => { reconcile(tabs, activeTabId) })
  }
}

/** In a collapsed group, so out of sight in the strip. */
function isHidden (tabs: TabManager, id: string): boolean {
  const groupId = tabs.record(id)?.groupId
  return groupId != null && groupsFor(tabs).get(groupId)?.collapsed === true
}
