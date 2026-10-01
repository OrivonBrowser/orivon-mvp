// What a delete in the manager can take back: the removed subtrees, kept in memory with the place each one held.
// Pure over the store's read side; the domain calls it around `remove`. Ids change on undo (the store mints new
// ones), so the answer names the restored rows for the page to reselect.
import type { BookmarkNode, BookmarkTreeInput } from './bookmark-types.js'
import type { BookmarkStore } from './bookmarks.js'

/** The most nodes one undo holds; a bigger delete is final. */
export const MAX_UNDO_NODES = 2_000
/** How long a delete stays undoable. */
export const UNDO_MS = 60_000

type Reader = Pick<BookmarkStore, 'node' | 'children' | 'path'>

export interface RemovedItem {
  readonly parent: string
  readonly index: number
  readonly tree: BookmarkTreeInput
}

export interface RemovedBatch {
  readonly token: string
  readonly at: number
  readonly items: readonly RemovedItem[]
}

function inputOf (store: Reader, node: BookmarkNode, count: { nodes: number }): BookmarkTreeInput {
  count.nodes += 1
  if (node.kind === 'url') {
    return { kind: 'url', title: node.title, ...(node.url === undefined ? {} : { url: node.url }), ...(node.favicon === undefined || node.favicon === null ? {} : { favicon: node.favicon }), added: node.added }
  }
  return { kind: 'folder', title: node.title, added: node.added, children: store.children(node.id).map((child) => inputOf(store, child, count)) }
}

/** The ids that are not inside another of the ids: deleting a folder takes what is in it. */
export function topLevel (store: Reader, ids: readonly string[]): string[] {
  const asked = new Set(ids)
  return [...asked].filter((id) => !store.path(id).slice(0, -1).some((above) => asked.has(above.id)))
}

/** The removal's record, read before the store changes; `nodes` counts every node in it, folders and their contents included. */
export function snapshot (store: Reader, ids: readonly string[]): { items: RemovedItem[], nodes: number } {
  const count = { nodes: 0 }
  const items: RemovedItem[] = []
  for (const id of ids) {
    const node = store.node(id)
    if (node === undefined) continue
    items.push({ parent: node.parent, index: store.children(node.parent).findIndex((sibling) => sibling.id === id), tree: inputOf(store, node, count) })
  }
  return { items, nodes: count.nodes }
}

type Writer = Pick<BookmarkStore, 'node' | 'children' | 'importTree'>

/** Puts the items back, each at its old position in its old folder (Other bookmarks when that folder is gone). Returns the new ids. */
export function restore (store: Writer, items: readonly RemovedItem[]): string[] {
  const ordered = [...items].sort((a, b) => a.parent === b.parent ? a.index - b.index : a.parent < b.parent ? -1 : 1)
  const restored: string[] = []
  for (const item of ordered) {
    const parent = store.node(item.parent)?.kind === 'folder' ? item.parent : 'other'
    const before = store.children(parent)
    const at = parent === item.parent ? Math.min(Math.max(item.index, 0), before.length) : before.length
    store.importTree(parent, [item.tree], at)
    const back = store.children(parent)
    const made = back.length > before.length ? back[at] : undefined
    if (made !== undefined) restored.push(made.id)
  }
  return restored
}
