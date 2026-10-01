// What the readers of a source's bookmarks share: one budget of nodes, the title clip, and the depth rule.
import type { BookmarkTreeInput } from '../browsing/bookmark-types.js'
import { MAX_IMPORT_LEVELS, MAX_IMPORT_NODES, MAX_IMPORT_TITLE } from './import-types.js'

/** A file can hold as many nodes as it likes: what is read is bounded, whatever the file says. */
export class NodeBudget {
  private left = MAX_IMPORT_NODES

  /** True while there is room, and uses one node of it. */
  take (): boolean {
    if (this.left <= 0) return false
    this.left -= 1
    return true
  }
}

export const clipTitle = (value: unknown): string => typeof value === 'string' ? value.slice(0, MAX_IMPORT_TITLE) : ''

/** Folders nested past this are not built: what is inside them goes into the deepest folder that is. */
export const tooDeep = (depth: number): boolean => depth >= MAX_IMPORT_LEVELS

/** The pages inside `root`, folders included or not, in reading order, without recursing: a hostile file may nest as deep as it likes. */
export function leavesOf<T> (root: T, children: (node: T) => readonly T[] | undefined, isPage: (node: T) => boolean, leaf: (node: T) => BookmarkTreeInput, budget: NodeBudget): BookmarkTreeInput[] {
  const out: BookmarkTreeInput[] = []
  const stack: T[] = [root]
  while (stack.length > 0) {
    const node = stack.pop() as T
    if (isPage(node)) {
      if (budget.take()) out.push(leaf(node))
      continue
    }
    const below = children(node) ?? []
    for (let index = below.length - 1; index >= 0; index -= 1) stack.push(below[index] as T)
  }
  return out
}
