// Keeps a window's strip true to the group rules after something else changed it. The pure decisions are
// group-order.ts's; this reads the tab collection, applies them, and says nothing when there is nothing to do.
import type { TabManager } from '../shell/tabs.js'
import { groupAfterMove, isNormal, normalise } from './group-order.js'
import type { GroupOf } from './group-order.js'
import { groupsFor } from './groups-model.js'

/** The windows whose strip this module is changing right now: a move it makes itself is not a person's move. */
const working = new WeakSet<object>()

export function isWorking (tabs: object): boolean {
  return working.has(tabs)
}

/** Runs `change` with the move and state hooks silenced for this window; false when it was already running one. */
export function whileWorking (tabs: object, change: () => void): boolean {
  if (working.has(tabs)) return false
  working.add(tabs)
  try {
    change()
  } finally {
    working.delete(tabs)
  }
  return true
}

/** A tab's group, counting only a group this window still has. */
export function liveGroupOf (tabs: TabManager): GroupOf {
  const groups = groupsFor(tabs)
  return (id) => {
    const group = tabs.record(id)?.groupId ?? null
    return group !== null && groups.has(group) ? group : null
  }
}

/** The tab, and the one it is joined to in a split, in the strip's order. */
export function blockOf (tabs: TabManager, id: string): string[] {
  const partner = tabs.splits.groups.partnerOf(id)
  return tabs.ids().filter((other) => other === id || other === partner)
}

/** Moves tabs one at a time until the strip reads `target`. Bounded: a move the strip refuses is left alone. */
export function applyOrder (tabs: TabManager, target: readonly string[]): void {
  for (let at = 0; at < target.length; at += 1) {
    const id = target[at]
    if (id !== undefined && tabs.ids()[at] !== id) tabs.moveTab(id, at)
  }
}

/** Takes away a group no tab holds any more. True when one went. */
function pruneEmpty (tabs: TabManager): boolean {
  const groups = groupsFor(tabs)
  const held = new Set(tabs.ids().map((id) => tabs.record(id)?.groupId ?? null))
  const empty = groups.list().filter((group) => !held.has(group.id))
  for (const group of empty) groups.remove(group.id)
  return empty.length > 0
}

/** Brings the window to the rules: no empty group, no pinned or half-split tab in a group, each group one run, and
 * the tab in front never hidden in a collapsed one. Pushes state itself when it changed anything. */
export function reconcile (tabs: TabManager, activeId: string | null): void {
  if (isWorking(tabs) || groupsFor(tabs).list().length === 0) return
  whileWorking(tabs, () => {
    const groups = groupsFor(tabs)
    let changed = pruneEmpty(tabs)
    const order = tabs.ids()
    const result = normalise(order, liveGroupOf(tabs), (id) => tabs.record(id)?.pinned === true, tabs.splits.groups.pairs())
    for (const [id, group] of result.groups) {
      const record = tabs.record(id)
      if (record !== undefined) record.groupId = group
      changed = true
    }
    if (!isNormal(result, order)) {
      applyOrder(tabs, result.order)
      changed = true
    }
    if (pruneEmpty(tabs)) changed = true
    const front = activeId === null ? null : tabs.record(activeId)?.groupId ?? null
    if (front !== null && groups.get(front)?.collapsed === true) {
      groups.update(front, { collapsed: false })
      changed = true
    }
    if (changed) tabs.changed()
  })
}

/** A person moved `id` (and its pair): the group it now belongs to follows from where it landed. */
export function settleMoved (tabs: TabManager, id: string): void {
  if (isWorking(tabs)) return
  const record = tabs.record(id)
  if (record === undefined) return
  if (record.pinned !== true) {
    const block = blockOf(tabs, id)
    const next = groupAfterMove(tabs.ids(), block, liveGroupOf(tabs))
    for (const member of block) {
      const owned = tabs.record(member)
      if (owned !== undefined) owned.groupId = next
    }
  }
  reconcile(tabs, null)
}
