// The tab groups of one window: a title, a colour and a collapsed flag per group. Pure; which tabs are in a group
// is each tab record's `groupId`, never kept here.
import type { GroupColor, TabGroupState } from '../shell/tab-extra-types.js'

export type { GroupColor, TabGroupState }

export const GROUP_COLORS: readonly GroupColor[] = ['gray', 'blue', 'red', 'orange', 'green', 'pink', 'purple', 'teal']
export const MAX_GROUP_TITLE = 40

export const isGroupColor = (value: unknown): value is GroupColor => typeof value === 'string' && (GROUP_COLORS as readonly string[]).includes(value)

/** A title as it is kept: text, trimmed, at most `MAX_GROUP_TITLE` characters. Anything else is empty. */
export function cleanGroupTitle (value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_GROUP_TITLE) : ''
}

export interface GroupPatch {
  title?: unknown
  color?: unknown
  collapsed?: unknown
}

/** What happened to which group; for a removal, the group as it was. */
export interface GroupsChange {
  kind: 'created' | 'updated' | 'removed'
  group: TabGroupState
}

export type GroupsListener = (change: GroupsChange) => void

/** One counter for the process: an id names a group in every window, so a tab's group is never mistaken for another window's. */
let nextGroupNumber = 1

export class TabGroups {
  private readonly groups = new Map<string, { title: string, color: GroupColor, collapsed: boolean }>()
  private readonly listeners = new Set<GroupsListener>()

  /** The first colour no group of this window uses; when all are used, the colours come round again. */
  nextColor (): GroupColor {
    const used = new Set([...this.groups.values()].map((group) => group.color))
    return GROUP_COLORS.find((color) => !used.has(color)) ?? GROUP_COLORS[this.groups.size % GROUP_COLORS.length] ?? 'gray'
  }

  create (color?: GroupColor, title = ''): string {
    const id = `g-${String(nextGroupNumber++)}`
    this.groups.set(id, { title: cleanGroupTitle(title), color: color !== undefined && isGroupColor(color) ? color : this.nextColor(), collapsed: false })
    this.changed('created', id)
    return id
  }

  /** Applies what is valid in `patch`; a colour outside the list is refused, and the group is unchanged by it. */
  update (id: string, patch: GroupPatch): boolean {
    const group = this.groups.get(id)
    if (group === undefined) return false
    let changed = false
    if ('title' in patch) {
      const title = cleanGroupTitle(patch.title)
      if (title !== group.title) { group.title = title; changed = true }
    }
    if (isGroupColor(patch.color) && patch.color !== group.color) { group.color = patch.color; changed = true }
    if (typeof patch.collapsed === 'boolean' && patch.collapsed !== group.collapsed) { group.collapsed = patch.collapsed; changed = true }
    if (changed) this.changed('updated', id)
    return changed
  }

  remove (id: string): boolean {
    const group = this.get(id)
    if (group === undefined) return false
    this.groups.delete(id)
    this.notify({ kind: 'removed', group })
    return true
  }

  has (id: string): boolean {
    return this.groups.has(id)
  }

  get (id: string): TabGroupState | undefined {
    const group = this.groups.get(id)
    return group === undefined ? undefined : { id, ...group }
  }

  list (): TabGroupState[] {
    return [...this.groups].map(([id, group]) => ({ id, ...group }))
  }

  /** Fires after a group is created, changed or removed, with which and what it became. Returns the removal. */
  onChange (listener: GroupsListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private changed (kind: 'created' | 'updated', id: string): void {
    const group = this.get(id)
    if (group !== undefined) this.notify({ kind, group })
  }

  private notify (change: GroupsChange): void {
    for (const listener of [...this.listeners]) listener(change)
  }
}

const perWindow = new WeakMap<object, TabGroups>()

/** The groups of the window whose tab collection is `tabs`. */
export function groupsFor (tabs: object): TabGroups {
  let groups = perWindow.get(tabs)
  if (groups === undefined) {
    groups = new TabGroups()
    perWindow.set(tabs, groups)
  }
  return groups
}
