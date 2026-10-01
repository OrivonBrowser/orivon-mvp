// Where grouped tabs sit in the strip: pure decisions over a list of tab ids. The strip's other rules (the pinned
// run, joined pairs) are tab-order.ts's; these add that a group is one run of neighbours.
import type { JoinedPair } from '../shell/tab-order.js'

/** The group a tab is in, or null. */
export type GroupOf = (id: string) => string | null

/** The first and last place of a group's tabs in `order`, or null when it has none. */
export function runOf (order: readonly string[], groupId: string, groupOf: GroupOf): [number, number] | null {
  let start = -1
  let end = -1
  order.forEach((id, at) => {
    if (groupOf(id) !== groupId) return
    if (start === -1) start = at
    end = at
  })
  return start === -1 ? null : [start, end]
}

/** The group a tab, or a joined pair (`moved`, as they now sit in `order`), belongs to after a move.
 * Between two tabs of one group it joins that group; at the edge of the group it already belongs to it stays;
 * anywhere else it is in none. */
export function groupAfterMove (order: readonly string[], moved: readonly string[], groupOf: GroupOf): string | null {
  const first = moved.reduce((low, id) => Math.min(low, order.indexOf(id)), Infinity)
  const last = moved.reduce((high, id) => Math.max(high, order.indexOf(id)), -1)
  if (!Number.isFinite(first) || last === -1) return null
  const before = order[first - 1]
  const after = order[last + 1]
  const beforeGroup = before === undefined ? null : groupOf(before)
  const afterGroup = after === undefined ? null : groupOf(after)
  if (beforeGroup !== null && beforeGroup === afterGroup) return beforeGroup
  const own = groupOf(moved[0] ?? '')
  if (own !== null && (beforeGroup === own || afterGroup === own)) return own
  return null
}

/** Where `moved` goes (a place among the other tabs, as `moveTab` counts) to end up as the last of group `groupId`. */
export function placeInGroup (order: readonly string[], moved: readonly string[], groupId: string, groupOf: GroupOf): number {
  const rest = order.filter((id) => !moved.includes(id))
  const run = runOf(rest, groupId, groupOf)
  return run === null ? rest.length : run[1] + 1
}

/** Where `moved` goes (a place among the other tabs) to sit just after group `groupId`'s run, as a tab taken out of it does. */
export function placeAfterGroup (order: readonly string[], moved: readonly string[], groupId: string, groupOf: GroupOf): number {
  return placeInGroup(order, moved, groupId, (id) => moved.includes(id) ? null : groupOf(id))
}

export interface Normalised {
  /** The tabs whose group differs from what the rules allow, with the group each one has instead. */
  readonly groups: ReadonlyMap<string, string | null>
  /** The strip with each group gathered into one run, at the place of its first tab. */
  readonly order: readonly string[]
}

/** What brings a strip back to the rules: no pinned tab in a group, a joined pair wholly in one group or none (the
 * second pane takes the first pane's), and each group one run of neighbours. */
export function normalise (order: readonly string[], groupOf: GroupOf, isPinned: (id: string) => boolean, pairs: readonly JoinedPair[]): Normalised {
  const wanted = new Map<string, string | null>(order.map((id) => [id, isPinned(id) ? null : groupOf(id)]))
  for (const [first, second] of pairs) {
    if (wanted.has(first) && wanted.has(second)) wanted.set(second, wanted.get(first) ?? null)
  }
  const placed = new Set<string>()
  const next: string[] = []
  for (const id of order) {
    if (placed.has(id)) continue
    const group = wanted.get(id) ?? null
    const run = group === null ? [id] : order.filter((other) => wanted.get(other) === group)
    for (const member of run) { next.push(member); placed.add(member) }
  }
  const groups = new Map<string, string | null>()
  for (const [id, group] of wanted) if (group !== groupOf(id)) groups.set(id, group)
  return { groups, order: next }
}

/** Whether `normalise` has nothing to change. */
export function isNormal (result: Normalised, order: readonly string[]): boolean {
  return result.groups.size === 0 && result.order.every((id, at) => id === order[at])
}

/** The tab to go to when group `groupId` collapses over the tab in front: the nearest one the strip still shows, the
 * one to the right when two are as near. Null when nothing is left to show, and a new tab is wanted. */
export function whenCollapsingActive (order: readonly string[], groupOf: GroupOf, collapsed: (groupId: string) => boolean, groupId: string, activeId: string): string | null {
  const at = order.indexOf(activeId)
  if (at === -1 || groupOf(activeId) !== groupId) return null
  const shown = (id: string): boolean => {
    const group = groupOf(id)
    return group === null || (group !== groupId && !collapsed(group))
  }
  for (let distance = 1; distance < order.length; distance += 1) {
    const right = order[at + distance]
    if (right !== undefined && shown(right)) return right
    const left = order[at - distance]
    if (left !== undefined && shown(left)) return left
  }
  return null
}

/** Where a key that moves `moved` one place `direction` ways sends it (a place among the other tabs): past one tab, or
 * past a whole group the strip shows as a chip. `hidden` says whether a tab is out of sight. */
export function stepPlace (order: readonly string[], moved: readonly string[], direction: -1 | 1, hidden: (id: string) => boolean, groupOf: GroupOf): number {
  const rest = order.filter((id) => !moved.includes(id))
  const first = order.findIndex((id) => moved.includes(id))
  const neighbour = rest[direction === 1 ? first : first - 1]
  if (neighbour === undefined) return first + direction
  const group = groupOf(neighbour)
  if (!hidden(neighbour) || group === null) return first + direction
  const run = runOf(rest, group, groupOf)
  if (run === null) return first + direction
  return direction === 1 ? run[1] + 1 : run[0]
}
