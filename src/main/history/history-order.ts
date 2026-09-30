// The listing by most visited or by title, from an offset: the orders `list`'s cursor cannot page through.
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { withFavicons } from './history-favicons.js'
import { LIKE_CONDITION, LIST_COLUMNS, likePattern, toEntry } from './history-list.js'
import type { Row } from './history-list.js'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './history-store.js'
import type { HistoryEntry, HistoryQuery } from './history-store.js'

/** Past this a person is scrolling a list no one reads to its end; a larger offset is taken as this. */
export const MAX_OFFSET = 100_000

// Ties end in `id`, so a page boundary never repeats or skips an entry. A page with no title sorts last, where
// its empty text would otherwise put it first.
const ORDERS = {
  recent: 'ORDER BY last_visit DESC, id DESC',
  visits: 'ORDER BY visit_count DESC, last_visit DESC, id DESC',
  title: "ORDER BY (title = '') ASC, title COLLATE NOCASE ASC, id ASC"
} as const

type Orders = Record<'recent' | 'visits' | 'title', { all: StatementSync, search: StatementSync }>

const prepared = new WeakMap<DatabaseSync, Orders>()

/** Prepares the statements of this module once, so a read never has to. */
export function prepareOrderStatements (db: DatabaseSync): Orders {
  let found = prepared.get(db)
  if (found === undefined) {
    const pair = (order: string): { all: StatementSync, search: StatementSync } => ({
      all: db.prepare(`SELECT ${LIST_COLUMNS} FROM pages ${order} LIMIT ? OFFSET ?`),
      search: db.prepare(`SELECT ${LIST_COLUMNS} FROM pages WHERE ${LIKE_CONDITION} ${order} LIMIT ? OFFSET ?`)
    })
    found = { recent: pair(ORDERS.recent), visits: pair(ORDERS.visits), title: pair(ORDERS.title) }
    prepared.set(db, found)
  }
  return found
}

/** The entries `query` asks for in `query.order` from `query.offset`, each with its icon. An unknown order is most recent first. */
export function listPagesOrdered (db: DatabaseSync, query: HistoryQuery): HistoryEntry[] {
  const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? DEFAULT_PAGE_SIZE)), MAX_PAGE_SIZE)
  const offset = Math.min(Math.max(0, Math.trunc(query.offset ?? 0)), MAX_OFFSET)
  const search = query.search?.trim() ?? ''
  const order = query.order === 'visits' || query.order === 'title' ? query.order : 'recent'
  const { all, search: searched } = prepareOrderStatements(db)[order]
  const rows = (search === '' ? all.all(limit, offset) : searched.all(likePattern(search), likePattern(search), limit, offset)) as unknown as Row[]
  return withFavicons(db, rows.map(toEntry))
}
