// The reading list: pages saved for later, unread ones first.
import { sanitizeDirectUrl } from '../../browsing/omnibox.js'
import { holds, hostOf } from '../panel-types.js'
import type { PanelRow, PanelViewDef } from '../panel-types.js'

export const readingView: PanelViewDef = {
  id: 'reading',
  title: 'Reading list',
  icon: 'reading',
  searchLabel: 'Search reading list',
  things: 'pages',
  empty: 'Pages you save for later appear here.',
  rows ({ services }, query) {
    const nodes = services.bookmarks.children('reading').filter((node) => node.kind === 'url' && holds(query, node.title, node.url ?? ''))
    const section = (title: string, read: boolean): PanelRow[] => {
      const part = nodes.filter((node) => (node.read === true) === read)
      return part.length === 0 ? [] : [
        { id: `section-${read ? 'read' : 'unread'}`, kind: 'header', title },
        ...part.map((node): PanelRow => {
          const host = hostOf(node.url ?? '')
          return { id: node.id, kind: 'item', title: node.title === '' ? (node.url ?? '') : node.title, ...(host === '' ? {} : { sub: host }), favicon: node.favicon ?? null }
        })
      ]
    }
    return [...section('Unread', false), ...section('Pages you have read', true)]
  },
  resolve ({ services }, id) {
    const node = services.bookmarks.node(id)
    return node !== undefined && node.parent === 'reading' && node.url !== undefined ? sanitizeDirectUrl(node.url) : null
  },
  opened ({ services }, id) {
    services.bookmarks.update(id, { read: true })
  },
  remove ({ services }, id) {
    if (services.bookmarks.node(id)?.parent === 'reading') services.bookmarks.remove([id])
  },
  watch: ({ services }, changed) => services.bookmarks.onChange(changed)
}
