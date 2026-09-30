// The bookmark tree as the shell and its pages speak of it. Types only: the store that keeps it is `bookmarks.ts`.

/** The three places a bookmark can be filed directly: the bar, everything else, and the reading list. */
export type BookmarkRoot = 'bar' | 'other' | 'reading'

/** One row of the tree. A root's id is its own name; every other id is random. */
export interface BookmarkNode {
  id: string
  /** The id of the folder or root it is in. */
  parent: string
  kind: 'url' | 'folder'
  title: string
  /** Present on a `url` node, absent on a folder. */
  url?: string
  favicon?: string | null
  /** Milliseconds since the epoch. */
  added: number
  /** Reading list entries only: whether the page was opened from it. */
  read?: boolean
}

/** What the bookmarks bar draws for one of its children. */
export interface BarItem {
  id: string
  kind: 'url' | 'folder'
  title: string
  url?: string
  favicon?: string | null
}

/** A tree to add in one write, as an import or an export reads and writes it. */
export interface BookmarkTreeInput {
  kind: 'url' | 'folder'
  title: string
  url?: string
  added?: number
  children?: BookmarkTreeInput[]
}
