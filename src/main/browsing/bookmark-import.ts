// Whole trees in and out of the bookmark tree in one operation: what an import adds and what an export reads.
// Pure, like bookmark-tree.ts; the store makes the one write and the one change event around a call.
import { MAX_DEPTH, MAX_NODES, childrenOf, clipTitle, depthOf, freshId, nodeCount } from './bookmark-tree.js'
import type { BookmarkTree, IdSource, TreeDraft } from './bookmark-tree.js'
import type { BookmarkNode, BookmarkRoot, BookmarkTreeInput } from './bookmark-types.js'
import { sanitizeDirectUrl } from './omnibox.js'

export interface ImportResult {
  tree: BookmarkTree
  /** Pages added; folders are not counted. */
  added: number
  /** Nodes added, folders included: whether the tree changed at all. */
  nodes: number
}

/** Adds `input` under `parent` at `index`. A page whose address is not openable is dropped, a folder past the depth
 * limit is dropped with what is in it, and the adding stops at the node cap. Null when `parent` is not a folder. */
export function importNodes (tree: BookmarkTree, parent: string, input: readonly BookmarkTreeInput[], index: number | undefined, newId: IdSource, now: number): ImportResult | null {
  const folder = tree.nodes.get(parent)
  if (folder === undefined || folder.kind !== 'folder') return null
  const reading = parent === 'reading'
  const draft: TreeDraft = { nodes: new Map(tree.nodes), kids: new Map(tree.kids) }
  let budget = MAX_NODES - nodeCount(tree)
  let added = 0
  let nodes = 0

  const build = (items: readonly BookmarkTreeInput[], into: string, depth: number): string[] => {
    const ids: string[] = []
    if (depth > MAX_DEPTH) return ids
    for (const item of items) {
      if (budget <= 0) break
      const stamp = typeof item.added === 'number' && Number.isFinite(item.added) ? item.added : now
      if (item.kind === 'url') {
        const url = typeof item.url === 'string' ? sanitizeDirectUrl(item.url) : null
        if (url === null) continue
        const id = freshId(draft.nodes, newId)
        draft.nodes.set(id, { id, parent: into, kind: 'url', title: clipTitle(String(item.title ?? '')), url, favicon: null, added: stamp })
        ids.push(id)
        budget -= 1
        added += 1
        nodes += 1
      } else if (item.kind === 'folder' && !reading) {
        const id = freshId(draft.nodes, newId)
        draft.nodes.set(id, { id, parent: into, kind: 'folder', title: clipTitle(String(item.title ?? '')), added: stamp })
        draft.kids.set(id, [])
        budget -= 1
        nodes += 1
        draft.kids.set(id, build(Array.isArray(item.children) ? item.children : [], id, depth + 1))
        ids.push(id)
      }
    }
    return ids
  }

  const made = build(input, parent, depthOf(tree, parent) + 1)
  if (nodes === 0) return { tree, added: 0, nodes: 0 }
  const list = [...draft.kids.get(parent) ?? []]
  const at = index === undefined || !Number.isFinite(index) ? list.length : Math.min(Math.max(Math.trunc(index), 0), list.length)
  list.splice(at, 0, ...made)
  draft.kids.set(parent, list)
  return { tree: draft, added, nodes }
}

function inputOf (tree: BookmarkTree, node: BookmarkNode): BookmarkTreeInput {
  if (node.kind === 'url') return { kind: 'url', title: node.title, ...(node.url === undefined ? {} : { url: node.url }), added: node.added }
  return { kind: 'folder', title: node.title, added: node.added, children: childrenOf(tree, node.id).map((child) => inputOf(tree, child)) }
}

/** The bar and Other bookmarks as nested inputs, in order; ids and favicons are not part of a portable tree. */
export function exportNodes (tree: BookmarkTree): Record<'bar' | 'other', BookmarkTreeInput[]> {
  const root = (id: BookmarkRoot): BookmarkTreeInput[] => childrenOf(tree, id).map((child) => inputOf(tree, child))
  return { bar: root('bar'), other: root('other') }
}
