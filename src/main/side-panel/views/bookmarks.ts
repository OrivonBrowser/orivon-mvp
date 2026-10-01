// The bookmark tree: the bar and "Other bookmarks" as folders, or a flat list of matches while a query is typed.
import type { BookmarkNode } from '../../browsing/bookmark-types.js'
import { sanitizeDirectUrl } from '../../browsing/omnibox.js'
import { hostOf } from '../panel-types.js'
import type { PanelRow, PanelViewDef } from '../panel-types.js'

/** The most rows one list sends: a tree this large is searched, not scrolled. */
export const MAX_ROWS = 1000
const SEARCH_LIMIT = 200
const ROOTS: ReadonlyArray<{ id: 'bar' | 'other', title: string }> = [
  { id: 'bar', title: 'Bookmarks bar' },
  { id: 'other', title: 'Other bookmarks' }
]

function rowOf (node: BookmarkNode, level: number, open: ReadonlySet<string>): PanelRow {
  if (node.kind === 'folder') return { id: node.id, kind: 'folder', title: node.title, level, expanded: open.has(node.id) }
  const host = hostOf(node.url ?? '')
  return { id: node.id, kind: 'item', title: node.title === '' ? (node.url ?? '') : node.title, ...(host === '' ? {} : { sub: host }), favicon: node.favicon ?? null, level }
}

export const bookmarksView: PanelViewDef = {
  id: 'bookmarks',
  title: 'Bookmarks',
  icon: 'bookmarks',
  searchLabel: 'Search bookmarks',
  things: 'bookmarks',
  empty: 'Bookmarks you save appear here.',
  rows ({ services }, query, open) {
    const store = services.bookmarks
    if (query.trim() !== '') return store.search(query, SEARCH_LIMIT).map((node) => rowOf(node, 0, open))
    const rows: PanelRow[] = []
    const walk = (parent: string, level: number): void => {
      for (const node of store.children(parent)) {
        if (rows.length >= MAX_ROWS) return
        rows.push(rowOf(node, level, open))
        if (node.kind === 'folder' && open.has(node.id)) walk(node.id, level + 1)
      }
    }
    for (const root of ROOTS) {
      if (store.children(root.id).length === 0) continue
      rows.push({ id: root.id, kind: 'folder', title: root.title, level: 0, expanded: open.has(root.id) })
      if (open.has(root.id)) walk(root.id, 1)
    }
    return rows
  },
  resolve ({ services }, id) {
    const node = services.bookmarks.node(id)
    return node?.kind === 'url' && node.url !== undefined ? sanitizeDirectUrl(node.url) : null
  },
  remove ({ services }, id) {
    if (services.bookmarks.node(id)?.kind === 'url') services.bookmarks.remove([id])
  },
  watch: ({ services }, changed) => services.bookmarks.onChange(changed)
}
