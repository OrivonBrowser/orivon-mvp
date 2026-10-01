// A bookmark store for tests: the real tree operations over an in-memory tree, with nothing on disk.
import { importNodes } from '../../browsing/bookmark-import.js'
import { childrenOf, emptyTree } from '../../browsing/bookmark-tree.js'
import type { BookmarkTree } from '../../browsing/bookmark-tree.js'
import type { BookmarkNode, BookmarkTreeInput } from '../../browsing/bookmark-types.js'
import type { BookmarkSink } from '../bookmark-merge.js'

export class TreeSink implements BookmarkSink {
  tree: BookmarkTree = emptyTree()
  calls = 0
  private next = 0

  children (parent: string): BookmarkNode[] {
    return childrenOf(this.tree, parent)
  }

  importTree (parent: string, tree: readonly BookmarkTreeInput[]): number {
    this.calls += 1
    const result = importNodes(this.tree, parent, tree, undefined, () => `n${String(this.next++)}`, 1000)
    if (result === null) return 0
    this.tree = result.tree
    return result.added
  }

  /** The titles under a parent, folders marked with a slash. */
  titles (parent: string): string[] {
    return this.children(parent).map((node) => node.kind === 'folder' ? `${node.title}/` : node.title)
  }

  find (parent: string, title: string): BookmarkNode | undefined {
    return this.children(parent).find((node) => node.title === title)
  }
}

export const page = (title: string, url = `https://${title.toLowerCase()}.test/`): BookmarkTreeInput => ({ kind: 'url', title, url })
export const folder = (title: string, ...children: BookmarkTreeInput[]): BookmarkTreeInput => ({ kind: 'folder', title, children })
