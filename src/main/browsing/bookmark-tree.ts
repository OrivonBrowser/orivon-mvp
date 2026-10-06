// The bookmark tree and every operation on it. Pure: each operation returns a new tree (or null when it
// refuses), so the store that keeps the tree holds one reference and a refused call changes nothing.
// A tree is two maps, the nodes by id and each folder's child ids in order, which keeps an id lookup and a
// move O(1) in the node count; an operation copies the maps once, which is cheap at the node cap.
import { randomBytes } from 'node:crypto'
import type { BookmarkNode, BookmarkRoot } from './bookmark-types.js'
import { sanitizeBrowserUrl } from './local-file-input.js'

export const MAX_NODES = 20_000
/** What an id looks like: the bookmarks page names a folder in its address and the page's requests name rows, and both
 * take only this. The renderer's router keeps a copy of it, since it cannot import from here. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
/** Levels below a root: a root's children are at depth 1. */
export const MAX_DEPTH = 12
export const MAX_TITLE = 512

export const ROOTS: readonly BookmarkRoot[] = ['bar', 'other', 'reading']
/** The two roots the bar, the star and the pickers deal in; the reading list is its own surface. */
export const BOOKMARK_ROOTS: readonly BookmarkRoot[] = ['bar', 'other']
const ROOT_TITLES: Record<BookmarkRoot, string> = { bar: 'Bookmarks bar', other: 'Other bookmarks', reading: 'Reading list' }

export interface BookmarkTree {
  readonly nodes: ReadonlyMap<string, BookmarkNode>
  /** A folder's children, in order. Every folder and root has an entry, possibly empty. */
  readonly kids: ReadonlyMap<string, readonly string[]>
}

/** Where a new id comes from; a test supplies a counter. */
export type IdSource = () => string
export const randomId: IdSource = () => randomBytes(6).toString('hex')

export interface TreeDraft {
  nodes: Map<string, BookmarkNode>
  kids: Map<string, readonly string[]>
}

export const isRoot = (id: string): id is BookmarkRoot => (ROOTS as readonly string[]).includes(id)
export const clipTitle = (title: string): string => title.length > MAX_TITLE ? title.slice(0, MAX_TITLE) : title

export function emptyDraft (): TreeDraft {
  const draft: TreeDraft = { nodes: new Map(), kids: new Map() }
  for (const root of ROOTS) {
    draft.nodes.set(root, { id: root, parent: '', kind: 'folder', title: ROOT_TITLES[root], added: 0 })
    draft.kids.set(root, [])
  }
  return draft
}

export const emptyTree = (): BookmarkTree => emptyDraft()

const draftOf = (tree: BookmarkTree): TreeDraft => ({ nodes: new Map(tree.nodes), kids: new Map(tree.kids) })

/** A fresh id: never a root's name and never one in use. */
export function freshId (nodes: ReadonlyMap<string, unknown>, newId: IdSource): string {
  for (;;) {
    const id = newId()
    if (id.length > 0 && !nodes.has(id)) return id
  }
}

/** Nodes below the roots: what the cap counts. */
export const nodeCount = (tree: BookmarkTree): number => tree.nodes.size - ROOTS.length

export function childrenOf (tree: BookmarkTree, id: string): BookmarkNode[] {
  const out: BookmarkNode[] = []
  for (const child of tree.kids.get(id) ?? []) {
    const node = tree.nodes.get(child)
    if (node !== undefined) out.push(node)
  }
  return out
}

/** The nodes from the root down to `id`, both included; empty for an unknown id. */
export function pathTo (tree: BookmarkTree, id: string): BookmarkNode[] {
  const path: BookmarkNode[] = []
  let current = tree.nodes.get(id)
  while (current !== undefined && path.length <= MAX_DEPTH + 1) {
    path.unshift(current)
    current = tree.nodes.get(current.parent)
  }
  return path[0] !== undefined && isRoot(path[0].id) ? path : []
}

/** 0 for a root, -1 for an unknown id. */
export function depthOf (tree: BookmarkTree, id: string): number {
  return pathTo(tree, id).length - 1
}

/** Levels the subtree at `id` spans, itself included. */
function heightOf (tree: BookmarkTree, id: string): number {
  let deepest = 0
  for (const child of tree.kids.get(id) ?? []) deepest = Math.max(deepest, heightOf(tree, child))
  return deepest + 1
}

function subtreeIds (tree: BookmarkTree, id: string, into: string[] = []): string[] {
  into.push(id)
  for (const child of tree.kids.get(id) ?? []) subtreeIds(tree, child, into)
  return into
}

/** The reading list is a flat list of pages: a folder does not go in it. */
function accepts (tree: BookmarkTree, parent: string, node: Pick<BookmarkNode, 'kind'>): boolean {
  const folder = tree.nodes.get(parent)
  if (folder === undefined || folder.kind !== 'folder') return false
  return !(node.kind === 'folder' && pathTo(tree, parent)[0]?.id === 'reading')
}

function place (kids: Map<string, readonly string[]>, parent: string, ids: readonly string[], index: number | undefined): void {
  const list = [...kids.get(parent) ?? []]
  const at = index === undefined || !Number.isFinite(index) ? list.length : Math.min(Math.max(Math.trunc(index), 0), list.length)
  list.splice(at, 0, ...ids)
  kids.set(parent, list)
}

export interface NewNode { kind: 'url' | 'folder', title: string, url?: string, favicon?: string | null, added: number, read?: boolean }

/** `node` filed under `parent` at `index` (the end when absent), or null past a limit or into something that is not a folder. */
export function addNode (tree: BookmarkTree, node: NewNode, parent: string, index: number | undefined, newId: IdSource): { tree: BookmarkTree, node: BookmarkNode } | null {
  if (nodeCount(tree) >= MAX_NODES || !accepts(tree, parent, node)) return null
  if (depthOf(tree, parent) + 1 > MAX_DEPTH) return null
  const draft = draftOf(tree)
  const id = freshId(draft.nodes, newId)
  const made: BookmarkNode = { ...node, id, parent, title: clipTitle(node.title) }
  draft.nodes.set(id, made)
  if (node.kind === 'folder') draft.kids.set(id, [])
  place(draft.kids, parent, [id], index)
  return { tree: draft, node: made }
}

/** Moves `ids` (in the order given) under `parent`. `index` is a position in `parent`'s list as it stands now, so a
 * drop "before the third item" means the same whichever side of it the moved items came from. Refuses a root, a
 * folder into itself or its own subtree, and anything that would pass the depth limit. */
export function moveNodes (tree: BookmarkTree, ids: readonly string[], parent: string, index?: number): BookmarkTree | null {
  const unique = [...new Set(ids)]
  if (unique.length === 0 || unique.some((id) => !tree.nodes.has(id) || isRoot(id))) return null
  const parentPath = pathTo(tree, parent)
  if (parentPath.length === 0) return null
  if (unique.some((id) => parentPath.some((above) => above.id === id))) return null
  // An item whose ancestor moves too goes along with it.
  const moving = unique.filter((id) => !pathTo(tree, id).slice(0, -1).some((above) => unique.includes(above.id)))
  for (const id of moving) {
    const node = tree.nodes.get(id)
    if (node === undefined || !accepts(tree, parent, node)) return null
    if (parentPath.length - 1 + heightOf(tree, id) > MAX_DEPTH) return null
  }
  const draft = draftOf(tree)
  const before = tree.kids.get(parent) ?? []
  const cut = index === undefined ? before.length : Math.min(Math.max(Math.trunc(index), 0), before.length)
  const shift = before.slice(0, cut).filter((id) => moving.includes(id)).length
  for (const id of moving) {
    const node = tree.nodes.get(id) as BookmarkNode
    draft.kids.set(node.parent, (draft.kids.get(node.parent) ?? []).filter((kid) => kid !== id))
    draft.nodes.set(id, { ...node, parent })
  }
  place(draft.kids, parent, moving, cut - shift)
  return draft
}

/** Removes `ids` with everything under them; `removed` counts the distinct ids asked for that were there. Roots stay. */
export function removeNodes (tree: BookmarkTree, ids: readonly string[]): { tree: BookmarkTree, removed: number } {
  const asked = [...new Set(ids)].filter((id) => tree.nodes.has(id) && !isRoot(id))
  if (asked.length === 0) return { tree, removed: 0 }
  const draft = draftOf(tree)
  for (const id of asked) {
    const node = draft.nodes.get(id)
    if (node === undefined) continue
    draft.kids.set(node.parent, (draft.kids.get(node.parent) ?? []).filter((kid) => kid !== id))
    for (const gone of subtreeIds(draft, id)) {
      draft.nodes.delete(gone)
      draft.kids.delete(gone)
    }
  }
  return { tree: draft, removed: asked.length }
}

export interface NodePatch { title?: string, url?: string, read?: boolean }

/** Null for an unknown id, a root, or a patch that does not fit the node (a URL on a folder, a URL that is not openable). */
export function updateNode (tree: BookmarkTree, id: string, patch: NodePatch): BookmarkTree | null {
  const node = tree.nodes.get(id)
  if (node === undefined || isRoot(id)) return null
  const next: BookmarkNode = { ...node }
  if (patch.title !== undefined) next.title = clipTitle(patch.title)
  if (patch.url !== undefined) {
    const safe = node.kind === 'url' ? sanitizeBrowserUrl(patch.url) : null
    if (safe === null) return null
    next.url = safe
  }
  if (patch.read !== undefined) {
    if (node.kind !== 'url') return null
    next.read = patch.read
  }
  const draft = draftOf(tree)
  draft.nodes.set(id, next)
  return draft
}

/** Gives `favicon` to every page of that address that has none; null when nothing changed. */
export function fillFavicon (tree: BookmarkTree, url: string, favicon: string): BookmarkTree | null {
  let draft: TreeDraft | null = null
  for (const node of tree.nodes.values()) {
    if (node.kind !== 'url' || node.url !== url || (node.favicon ?? null) !== null) continue
    draft ??= draftOf(tree)
    draft.nodes.set(node.id, { ...node, favicon })
  }
  return draft
}

/** The pages under `roots`, depth first in tree order. */
export function flattenUrls (tree: BookmarkTree, roots: readonly BookmarkRoot[] = BOOKMARK_ROOTS): BookmarkNode[] {
  const out: BookmarkNode[] = []
  const walk = (id: string): void => {
    for (const child of childrenOf(tree, id)) {
      if (child.kind === 'url') out.push(child)
      else walk(child.id)
    }
  }
  for (const root of roots) walk(root)
  return out
}

/** Pages of the bar and of Other bookmarks whose title or address holds `text`, case-insensitively. A blank text matches nothing. */
export function searchUrls (tree: BookmarkTree, text: string, limit: number): BookmarkNode[] {
  const needle = text.trim().toLowerCase()
  if (needle === '' || limit <= 0) return []
  const out: BookmarkNode[] = []
  for (const node of flattenUrls(tree)) {
    if (node.title.toLowerCase().includes(needle) || (node.url ?? '').toLowerCase().includes(needle)) {
      out.push(node)
      if (out.length >= limit) break
    }
  }
  return out
}

/** The folders a page can be filed in, depth first, each root at depth 0. */
export function folderList (tree: BookmarkTree): Array<{ node: BookmarkNode, depth: number }> {
  const out: Array<{ node: BookmarkNode, depth: number }> = []
  const walk = (node: BookmarkNode, depth: number): void => {
    out.push({ node, depth })
    for (const child of childrenOf(tree, node.id)) if (child.kind === 'folder') walk(child, depth + 1)
  }
  for (const root of BOOKMARK_ROOTS) {
    const node = tree.nodes.get(root)
    if (node !== undefined) walk(node, 0)
  }
  return out
}
