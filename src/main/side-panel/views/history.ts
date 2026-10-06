// The newest pages visited, most recent first. The page groups them by day, in the person's own clock.
import { sanitizeBrowserUrl } from '../../browsing/local-file-input.js'
import { hostOf } from '../panel-types.js'
import type { PanelViewDef } from '../panel-types.js'

/** The panel shows the newest of these; the full page has the rest. */
export const HISTORY_LIMIT = 200

const idOf = (id: string): number | null => /^\d{1,15}$/.test(id) ? Number(id) : null

export const historyView: PanelViewDef = {
  id: 'history',
  title: 'History',
  icon: 'history',
  searchLabel: 'Search history',
  things: 'pages',
  empty: 'Pages you visit appear here.',
  emptyPrivate: 'Private windows keep no history.',
  page: { label: 'Open full history', id: 'history' },
  rows ({ services }, query) {
    const search = query.trim()
    return services.history.listOrdered({ limit: HISTORY_LIMIT, ...(search === '' ? {} : { search }) }).map((entry) => {
      const host = hostOf(entry.url)
      return {
        id: String(entry.id), kind: 'item' as const, title: entry.title === '' ? entry.url : entry.title,
        ...(host === '' ? {} : { sub: host }), at: entry.lastVisit, favicon: entry.favicon ?? null
      }
    })
  },
  resolve ({ services }, id) {
    const key = idOf(id)
    const entry = key === null ? undefined : services.history.pagesByIds([key])[0]
    return entry === undefined ? null : sanitizeBrowserUrl(entry.url)
  },
  remove ({ services }, id) {
    const key = idOf(id)
    if (key !== null) services.history.remove(key)
  },
  watch: ({ services }, changed) => services.history.onChange(changed)
}
