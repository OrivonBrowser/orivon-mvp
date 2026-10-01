// Wires one window's strip to the group rules: the hooks the tab collection calls after a move or a link opening,
// and the check that runs after every state change.
import type { WindowHook } from '../shell/window-hooks.js'
import { joinOpenerGroup } from './groups-runner.js'
import { reconcile, settleMoved } from './groups-sync.js'

export const tabGroupsHook: WindowHook = {
  name: 'tab-groups',
  opened: ({ window }) => {
    const { tabs } = window
    tabs.afterMove = (id) => { settleMoved(tabs, id) }
    tabs.afterOpen = (id, opener) => { joinOpenerGroup(tabs, id, opener) }
    tabs.onStateChange(({ activeTabId }) => { reconcile(tabs, activeTabId) })
  }
}
