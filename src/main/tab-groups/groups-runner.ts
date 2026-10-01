// What the group commands do to a window's tabs. Each one sets the tabs' `groupId`, moves them with the strip's own
// `moveTab`, and lets groups-sync.ts see that the rules still hold. Tied to Electron through the tab collection.
import { clampToRun, clearOfPairs, pinnedCount } from '../shell/tab-order.js'
import { sendChromeEvent } from '../shell/shell-events.js'
import { setPinned } from '../shell/tab-pin.js'
import type { WindowContext } from '../shell/window-context.js'
import type { TabManager } from '../shell/tabs.js'
import { placeAfterGroup, placeInGroup, stepPlace, whenCollapsingActive } from './group-order.js'
import { groupsFor } from './groups-model.js'
import { applyOrder, blockOf, liveGroupOf, reconcile, whileWorking } from './groups-sync.js'

export { groupsFor }

/** The chrome module that draws the chips, which main asks to open a group's bubble. */
export const TAB_GROUPS_MODULE = 'tab-groups'

function setGroup (tabs: TabManager, ids: readonly string[], group: string | null): void {
  for (const id of ids) {
    const record = tabs.record(id)
    if (record !== undefined) record.groupId = group
  }
}

/** The tabs in group `groupId`, in the strip's order. */
export function membersOf (tabs: TabManager, groupId: string): string[] {
  const groupOf = liveGroupOf(tabs)
  return tabs.ids().filter((id) => groupOf(id) === groupId)
}

/** Puts the tab, with the tab it is split with, in an existing group (at its end) or in a new one. A pinned tab is
 * unpinned. Returns the group's id, or undefined when the tab or the group is not here. */
export function groupTab (ctx: WindowContext, tabId: string, groupId: string | 'new'): string | undefined {
  const { tabs } = ctx.window
  const groups = groupsFor(tabs)
  if (tabs.record(tabId) === undefined || (groupId !== 'new' && !groups.has(groupId))) return undefined
  for (const id of blockOf(tabs, tabId)) if (tabs.record(id)?.pinned === true) setPinned(tabs, id, false)
  const block = blockOf(tabs, tabId)
  let target: string = groupId
  const ran = whileWorking(tabs, () => {
    const created = groupId === 'new'
    target = created ? groups.create() : groupId
    const at = created ? -1 : placeInGroup(tabs.ids(), block, target, liveGroupOf(tabs))
    setGroup(tabs, block, target)
    if (at !== -1) tabs.moveTab(block[0] ?? tabId, at)
  })
  if (!ran) return undefined
  reconcile(tabs, null)
  tabs.changed()
  return target
}

/** Takes the tab, with its split partner, out of its group, to just after the group's last tab. */
export function ungroupTab (ctx: WindowContext, tabId: string): void {
  const { tabs } = ctx.window
  const group = liveGroupOf(tabs)(tabId)
  if (group === null) return
  const block = blockOf(tabs, tabId)
  whileWorking(tabs, () => {
    const others = membersOf(tabs, group).length > block.length
    const at = placeAfterGroup(tabs.ids(), block, group, liveGroupOf(tabs))
    setGroup(tabs, block, null)
    if (others) tabs.moveTab(block[0] ?? tabId, at)
  })
  reconcile(tabs, null)
  tabs.changed()
}

/** Dissolves the group: its tabs stay where they are, in none. */
export function ungroupAll (ctx: WindowContext, groupId: string): void {
  const { tabs } = ctx.window
  setGroup(tabs, membersOf(tabs, groupId), null)
  reconcile(tabs, null)
  tabs.changed()
}

/** Closes every tab of the group. */
export function closeGroup (ctx: WindowContext, groupId: string): void {
  const { tabs } = ctx.window
  for (const id of membersOf(tabs, groupId)) tabs.closeTab(id)
}

/** Hides the group's tabs behind its chip, or shows them again. Collapsing over the tab in front goes to the
 * nearest tab still shown, or to a new tab when none is. */
export function toggleCollapsed (ctx: WindowContext, groupId: string): void {
  const { tabs } = ctx.window
  const groups = groupsFor(tabs)
  const group = groups.get(groupId)
  if (group === undefined) return
  if (group.collapsed) {
    groups.update(groupId, { collapsed: false })
    tabs.changed()
    return
  }
  const groupOf = liveGroupOf(tabs)
  const active = tabs.getState().activeTabId
  if (active !== null && groupOf(active) === groupId) {
    const next = whenCollapsingActive(tabs.ids(), groupOf, (other) => groups.get(other)?.collapsed === true, groupId, active)
    if (next !== null) tabs.activateTab(next)
    else if (tabs.hasRoom()) tabs.createTab()
    else return
  }
  groups.update(groupId, { collapsed: true })
  tabs.changed()
}

/** Moves the whole group so it starts at `index`, a place among the tabs outside it, as `moveTab` counts. */
export function moveGroup (ctx: WindowContext, groupId: string, index: number): void {
  const { tabs } = ctx.window
  if (!Number.isFinite(index)) return
  const members = membersOf(tabs, groupId)
  if (members.length === 0) return
  const rest = tabs.ids().filter((id) => !members.includes(id))
  const wanted = clampToRun(Math.min(Math.max(0, Math.trunc(index)), rest.length), false, pinnedCount(rest, (id) => tabs.record(id)?.pinned === true), rest.length)
  const at = clearOfPairs(rest, wanted, tabs.splits.groups.pairs(), -1)
  whileWorking(tabs, () => { applyOrder(tabs, [...rest.slice(0, at), ...members, ...rest.slice(at)]) })
  reconcile(tabs, null)
  tabs.changed()
}

/** The tab the next or previous key goes to, wrapping at the ends and passing the tabs a collapsed group hides. */
export function shownNeighbour (tabs: TabManager, from: string | null, direction: -1 | 1): string | undefined {
  const ids = tabs.ids()
  const groups = groupsFor(tabs)
  const groupOf = liveGroupOf(tabs)
  const at = from === null ? -1 : ids.indexOf(from)
  for (let step = 1; step <= ids.length; step += 1) {
    const id = ids[((at + direction * step) % ids.length + ids.length) % ids.length]
    if (id !== undefined && groups.get(groupOf(id) ?? '')?.collapsed !== true) return id
  }
  return undefined
}

/** The keys that move a tab one place: past a tab, or past a whole collapsed group. Between two tabs of a group the
 * tab joins it, and past the group's edge it leaves it: `moveTab` settles that. */
export function stepTab (tabs: TabManager, id: string, direction: -1 | 1): void {
  const groups = groupsFor(tabs)
  const groupOf = liveGroupOf(tabs)
  const hidden = (other: string): boolean => groups.get(groupOf(other) ?? '')?.collapsed === true
  tabs.moveTab(id, stepPlace(tabs.ids(), blockOf(tabs, id), direction, hidden, groupOf))
}

/** A tab that came back (a closed tab reopened) goes into its old group, if the window still has it. */
export function rejoinGroup (tabs: TabManager, id: string, groupId: string): void {
  const record = tabs.record(id)
  if (record === undefined || record.pinned === true || !groupsFor(tabs).has(groupId)) return
  record.groupId = groupId
  reconcile(tabs, null)
  tabs.changed()
}

/** A tab a page opened from the tab in front joins that tab's group, at its end. */
export function joinOpenerGroup (tabs: TabManager, id: string, opener: string | null): void {
  if (opener === null || opener === id) return
  const group = liveGroupOf(tabs)(opener)
  if (group === null || tabs.record(id) === undefined) return
  const block = blockOf(tabs, id)
  whileWorking(tabs, () => {
    const at = placeInGroup(tabs.ids(), block, group, liveGroupOf(tabs))
    setGroup(tabs, block, group)
    tabs.moveTab(block[0] ?? id, at)
  })
  tabs.changed()
}

/** Asks the chrome to open the bubble of a group, under its chip. */
export function openGroupBubble (ctx: WindowContext, groupId: string): void {
  sendChromeEvent(ctx.window, TAB_GROUPS_MODULE, { type: 'menu', id: groupId })
}

/** The command and the tab menu's "Add Tab to New Group": a new group round the tab, with its bubble open to be named. */
export function groupTabNew (ctx: WindowContext, tabId: string): void {
  const group = groupTab(ctx, tabId, 'new')
  if (group !== undefined) openGroupBubble(ctx, group)
}
