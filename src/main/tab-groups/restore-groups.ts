// Makes a saved window's groups again once its tabs are open: each group the saved tabs point at, with its name,
// colour and collapsed state, holding the tabs that pointed at it.
import type { SavedWindow } from '../session-restore/session-types.js'
import type { TabManager } from '../shell/tabs.js'
import { groupsFor } from './groups-model.js'
import { reconcile } from './groups-sync.js'

/** `ids` holds the id each saved tab opened as, in the saved order ('' for one that did not open). `front` is the tab
 * shown first: a group that holds it stays open. */
export function restoreGroups (tabs: TabManager, saved: SavedWindow, ids: readonly string[], front: string | undefined): void {
  const described = saved.groups
  if (described === undefined || !saved.tabs.some((tab) => tab.group !== undefined)) return
  const groups = groupsFor(tabs)
  const made = new Map<number, string>()
  saved.tabs.forEach((snapshot, at) => {
    const id = ids[at]
    const record = id === undefined || id === '' ? undefined : tabs.record(id)
    const wanted = snapshot.group === undefined ? undefined : described[snapshot.group]
    if (record === undefined || wanted === undefined || snapshot.group === undefined || record.pinned === true) return
    let group = made.get(snapshot.group)
    if (group === undefined) {
      group = groups.create(wanted.color, wanted.title)
      made.set(snapshot.group, group)
    }
    record.groupId = group
  })
  const frontGroup = front === undefined ? null : tabs.record(front)?.groupId ?? null
  for (const [index, id] of made) {
    if (described[index]?.collapsed === true && id !== frontGroup) groups.update(id, { collapsed: true })
  }
  reconcile(tabs, front ?? null)
}
