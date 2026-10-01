// The bookmark tree as chrome.bookmarks shapes it. Pure: ids, indexes and nodes are decided here, the
// store and the router are not touched. Chrome's tree has a nameless root "0" over "Bookmarks bar" ("1",
// the store's `bar`) and "Other bookmarks" ("2", `other`); every other node keeps the store's own id. The
// store's reading list root has no id here at all: it is not part of this API.

export const CHROME_ROOT_ID = '0'
export const BAR_ID = '1'
export const OTHER_ID = '2'

/** What a node of the store and of a snapshot of it share. */
export interface NodeLike {
  readonly id: string
  readonly parent: string
  readonly kind: 'url' | 'folder'
  readonly title: string
  readonly url?: string | undefined
  readonly added: number
}

/** The Chrome `BookmarkTreeNode`. */
export interface ChromeBookmarkNode {
  id: string
  parentId?: string
  index?: number
  url?: string
  title: string
  dateAdded?: number
  dateGroupModified?: number
  children?: ChromeBookmarkNode[]
}

/** The store's id for a Chrome id; undefined for the Chrome root, and for a name the store alone uses (`bar`, `other`, `reading`). */
export function toStoreId (chromeId: string): string | undefined {
  if (chromeId === BAR_ID) return 'bar'
  if (chromeId === OTHER_ID) return 'other'
  if (chromeId === CHROME_ROOT_ID || chromeId === 'bar' || chromeId === 'other' || chromeId === 'reading') return undefined
  return chromeId
}

export function toChromeId (storeId: string): string {
  if (storeId === 'bar') return BAR_ID
  if (storeId === 'other') return OTHER_ID
  return storeId
}

/** The id of a node's parent as Chrome names it: a store root under the nameless root, a store `reading` nowhere. */
export function toChromeParentId (storeParent: string): string | undefined {
  if (storeParent === '') return CHROME_ROOT_ID
  return storeParent === 'reading' ? undefined : toChromeId(storeParent)
}

export const isChromeRoot = (chromeId: string): boolean => chromeId === CHROME_ROOT_ID || chromeId === BAR_ID || chromeId === OTHER_ID

export function toChromeNode (node: NodeLike, index: number | undefined, children?: ChromeBookmarkNode[]): ChromeBookmarkNode {
  const out: ChromeBookmarkNode = { id: toChromeId(node.id), title: node.title }
  const parentId = toChromeParentId(node.parent)
  if (parentId !== undefined) out.parentId = parentId
  if (index !== undefined) out.index = index
  if (node.kind === 'url') {
    if (node.url !== undefined) out.url = node.url
  }
  if (node.added > 0) out.dateAdded = node.added
  if (node.kind === 'folder') {
    if (node.added > 0) out.dateGroupModified = node.added
    if (children !== undefined) out.children = children
  }
  return out
}

/** The nameless root over the two real roots, as `getTree` and `get('0')` answer. */
export function chromeRoot (children?: ChromeBookmarkNode[]): ChromeBookmarkNode {
  const root: ChromeBookmarkNode = { id: CHROME_ROOT_ID, title: '' }
  if (children !== undefined) root.children = children
  return root
}

/** The words of a `search` string, lower-cased; a quoted phrase stays one word. */
export function queryWords (query: string): string[] {
  const words: string[] = []
  for (const match of query.toLowerCase().matchAll(/"([^"]*)"|(\S+)/g)) {
    const word = (match[1] ?? match[2] ?? '').trim()
    if (word !== '') words.push(word)
  }
  return words
}

/** Chrome's match: every word is somewhere in the title or the address. No words matches everything. */
export function matchesWords (node: Pick<NodeLike, 'title' | 'url'>, words: readonly string[]): boolean {
  const haystack = `${node.title}\n${node.url ?? ''}`.toLowerCase()
  return words.every((word) => haystack.includes(word))
}
