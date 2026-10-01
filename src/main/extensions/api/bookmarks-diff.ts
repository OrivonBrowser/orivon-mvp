// What changed between two snapshots of the bookmark tree. The store's change event carries no detail, so
// the events of chrome.bookmarks are derived: one snapshot is kept, and each change is compared with it.
// Pure, linear in the node count (the store caps the tree at 20,000), and it names only what Chrome
// reports: an untouched sibling whose index shifted is not a move.
import { toChromeId, toChromeNode, toChromeParentId } from './bookmarks-shape.js'
import type { ChromeBookmarkNode, NodeLike } from './bookmarks-shape.js'

export interface SnapNode extends NodeLike {
  readonly index: number
}

export interface Snapshot {
  readonly nodes: ReadonlyMap<string, SnapNode>
  /** Each folder's child ids in order, the two roots included. */
  readonly kids: ReadonlyMap<string, readonly string[]>
}

/** What the store offers a snapshot: a folder's children in order. */
export type ChildrenOf = (parentId: string) => readonly NodeLike[]

const ROOT_IDS: readonly string[] = ['bar', 'other']

export function takeSnapshot (childrenOf: ChildrenOf): Snapshot {
  const nodes = new Map<string, SnapNode>()
  const kids = new Map<string, string[]>()
  const walk = (parent: string): void => {
    const list: string[] = []
    childrenOf(parent).forEach((child, index) => {
      nodes.set(child.id, { ...child, index })
      list.push(child.id)
      if (child.kind === 'folder') walk(child.id)
    })
    kids.set(parent, list)
  }
  for (const root of ROOT_IDS) walk(root)
  return { nodes, kids }
}

/** The node and, for a folder when asked, everything below it, as the snapshot held them. */
export function snapshotNode (snap: Snapshot, id: string, withChildren: boolean): ChromeBookmarkNode | undefined {
  const node = snap.nodes.get(id)
  if (node === undefined) return undefined
  const children = node.kind === 'folder' && withChildren
    ? (snap.kids.get(id) ?? []).flatMap((child) => snapshotNode(snap, child, true) ?? [])
    : undefined
  return toChromeNode(node, node.index, children)
}

export type BookmarkChange =
  | { readonly type: 'created', readonly id: string, readonly node: ChromeBookmarkNode }
  | { readonly type: 'removed', readonly id: string, readonly info: { parentId: string, index: number, node: ChromeBookmarkNode } }
  | { readonly type: 'changed', readonly id: string, readonly info: { title: string, url?: string } }
  | { readonly type: 'moved', readonly id: string, readonly info: { parentId: string, index: number, oldParentId: string, oldIndex: number } }

/** Ids of `order` that are not in its longest increasing subsequence: the ones that moved when the rest kept their order. */
function outOfOrder (order: readonly number[]): Set<number> {
  const tails: number[] = []
  const tailAt: number[] = []
  const previous = new Array<number>(order.length).fill(-1)
  order.forEach((rank, at) => {
    let low = 0
    let high = tails.length
    while (low < high) {
      const mid = (low + high) >> 1
      if ((tails[mid] as number) < rank) low = mid + 1
      else high = mid
    }
    tails[low] = rank
    tailAt[low] = at
    previous[at] = low === 0 ? -1 : (tailAt[low - 1] as number)
  })
  const keep = new Set<number>()
  for (let at = tailAt[tails.length - 1] ?? -1; at >= 0; at = previous[at] as number) keep.add(order[at] as number)
  return new Set(order.filter((rank) => !keep.has(rank)))
}

/** A change per node that appeared, went, was retitled or re-addressed, or moved to another folder or past its siblings. */
export function diffSnapshots (before: Snapshot, after: Snapshot): BookmarkChange[] {
  const out: BookmarkChange[] = []
  for (const [id, old] of before.nodes) {
    // A node whose folder went too is part of that folder's one removal.
    if (after.nodes.has(id) || !(ROOT_IDS.includes(old.parent) || after.nodes.has(old.parent))) continue
    out.push({
      type: 'removed',
      id: toChromeId(id),
      info: { parentId: toChromeParentId(old.parent) ?? '0', index: old.index, node: snapshotNode(before, id, true) as ChromeBookmarkNode }
    })
  }
  const changed: BookmarkChange[] = []
  const moved: BookmarkChange[] = []
  for (const [id, now] of after.nodes) {
    const old = before.nodes.get(id)
    if (old === undefined) {
      out.push({ type: 'created', id: toChromeId(id), node: snapshotNode(after, id, false) as ChromeBookmarkNode })
      continue
    }
    if (old.title !== now.title || old.url !== now.url) {
      changed.push({ type: 'changed', id: toChromeId(id), info: now.kind === 'url' && now.url !== undefined ? { title: now.title, url: now.url } : { title: now.title } })
    }
    if (old.parent !== now.parent) {
      moved.push({
        type: 'moved',
        id: toChromeId(id),
        info: { parentId: toChromeParentId(now.parent) ?? '0', index: now.index, oldParentId: toChromeParentId(old.parent) ?? '0', oldIndex: old.index }
      })
    }
  }
  out.push(...changed, ...moved)
  // Within one folder: of the children that stayed, those out of their old relative order moved.
  for (const [parent, newKids] of after.kids) {
    const oldKids = before.kids.get(parent)
    if (oldKids === undefined || oldKids.length === newKids.length && oldKids.every((id, at) => id === newKids[at])) continue
    const stayed = (id: string): boolean => before.nodes.get(id)?.parent === parent && after.nodes.get(id)?.parent === parent
    const oldStayed = oldKids.filter(stayed)
    const newStayed = newKids.filter(stayed)
    if (oldStayed.length < 2 || oldStayed.every((id, at) => id === newStayed[at])) continue
    const rank = new Map(oldStayed.map((id, at) => [id, at]))
    const moved = outOfOrder(newStayed.map((id) => rank.get(id) as number))
    for (const at of moved) {
      const id = oldStayed[at] as string
      const now = after.nodes.get(id) as SnapNode
      out.push({
        type: 'moved',
        id: toChromeId(id),
        info: { parentId: toChromeParentId(parent) ?? '0', index: now.index, oldParentId: toChromeParentId(parent) ?? '0', oldIndex: (before.nodes.get(id) as SnapNode).index }
      })
    }
  }
  return out
}
