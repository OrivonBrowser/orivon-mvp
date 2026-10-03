// Firefox's profile list and its `places.sqlite`: where the profiles are, their bookmarks and their history.
// The queries run over a read-only copy (`sqlite-copy.ts`), and what they return is treated as untrusted text.
import type { DatabaseSync } from 'node:sqlite'
import type { BookmarkTreeInput } from '../browsing/bookmark-types.js'
import type { HistoryImportRow } from '../history/history-store.js'
import type { HistoryReadOptions } from './chromium-history.js'
import type { SourceBookmarks } from './import-types.js'
import { clipTitle, leavesOf, NodeBudget, tooDeep } from './source-tree.js'

export interface FirefoxProfileEntry {
  readonly name: string
  readonly path: string
  readonly isRelative: boolean
}

/** The `[ProfileN]` sections of a `profiles.ini`. Other sections (installs, general settings) are not profiles. */
export function parseProfilesIni (text: string): FirefoxProfileEntry[] {
  const entries: FirefoxProfileEntry[] = []
  let current: { name: string, path: string, isRelative: boolean } | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const section = /^\[(.*)\]$/.exec(line)
    if (section !== null) {
      current = /^Profile\d+$/i.test(section[1] ?? '') ? { name: '', path: '', isRelative: true } : null
      if (current !== null) entries.push(current)
      continue
    }
    if (current === null) continue
    const at = line.indexOf('=')
    if (at < 1) continue
    const key = line.slice(0, at).trim().toLowerCase()
    const value = line.slice(at + 1).trim()
    if (key === 'name') current.name = value
    else if (key === 'path') current.path = value
    else if (key === 'isrelative') current.isRelative = value !== '0'
  }
  return entries.filter((entry) => entry.path !== '')
}

interface PlaceRow {
  readonly id: number
  readonly type: number
  readonly parent: number
  readonly title: string
  readonly added: number | undefined
  readonly guid: string
  readonly url: string
}

const FOLDER_OF = { toolbar: 'toolbar_____', menu: 'menu________', unfiled: 'unfiled_____', mobile: 'mobile______' } as const
const TYPE_PAGE = 1
const TYPE_FOLDER = 2

const numberOf = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined

function readRows (db: DatabaseSync): PlaceRow[] {
  const rows = db.prepare(`
    SELECT b.id AS id, b.type AS type, b.parent AS parent, b.title AS title, b.dateAdded / 1000 AS added, b.guid AS guid, p.url AS url
    FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk ORDER BY b.parent, b.position
  `).all()
  const out: PlaceRow[] = []
  for (const row of rows) {
    const { id, type, parent, title, added, guid, url } = row as Record<string, unknown>
    const idNumber = numberOf(id)
    const typeNumber = numberOf(type)
    const parentNumber = numberOf(parent)
    if (idNumber === undefined || typeNumber === undefined || parentNumber === undefined) continue
    out.push({ id: idNumber, type: typeNumber, parent: parentNumber, title: typeof title === 'string' ? title : '', added: numberOf(added), guid: typeof guid === 'string' ? guid : '', url: typeof url === 'string' ? url : '' })
  }
  return out
}

/** The toolbar's items as the bar, and the menu's, the unfiled ones and the mobile ones as Other bookmarks. */
export function readFirefoxBookmarks (db: DatabaseSync): SourceBookmarks {
  const rows = readRows(db)
  const kids = new Map<number, PlaceRow[]>()
  for (const row of rows) kids.set(row.parent, [...kids.get(row.parent) ?? [], row])
  const childrenOf = (row: PlaceRow): readonly PlaceRow[] => kids.get(row.id) ?? []
  const isPage = (row: PlaceRow): boolean => row.type === TYPE_PAGE
  const pageOf = (row: PlaceRow): BookmarkTreeInput => ({ kind: 'url', title: clipTitle(row.title), url: row.url, ...(row.added === undefined || row.added <= 0 ? {} : { added: row.added }) })
  const budget = new NodeBudget()

  const convert = (list: readonly PlaceRow[], depth: number, out: BookmarkTreeInput[]): void => {
    for (const row of list) {
      if (row.type === TYPE_PAGE) {
        // A `place:` address is a saved query of Firefox's own, not a page.
        if (!row.url.startsWith('place:') && budget.take()) out.push(pageOf(row))
      } else if (row.type === TYPE_FOLDER) {
        if (tooDeep(depth)) {
          out.push(...leavesOf<PlaceRow>(row, childrenOf, isPage, pageOf, budget).filter((page) => !(page.url ?? '').startsWith('place:')))
        } else if (budget.take()) {
          const children: BookmarkTreeInput[] = []
          convert(childrenOf(row), depth + 1, children)
          out.push({ kind: 'folder', title: clipTitle(row.title), ...(row.added === undefined || row.added <= 0 ? {} : { added: row.added }), children })
        }
      }
    }
  }
  const itemsOf = (guid: string): PlaceRow[] => {
    const folder = rows.find((row) => row.guid === guid && row.type === TYPE_FOLDER)
    return folder === undefined ? [] : [...childrenOf(folder)]
  }
  const bar: BookmarkTreeInput[] = []
  const other: BookmarkTreeInput[] = []
  convert(itemsOf(FOLDER_OF.toolbar), 1, bar)
  convert(itemsOf(FOLDER_OF.menu), 1, other)
  convert(itemsOf(FOLDER_OF.unfiled), 1, other)
  const mobile: BookmarkTreeInput[] = []
  convert(itemsOf(FOLDER_OF.mobile), 2, mobile)
  if (mobile.length > 0) other.push({ kind: 'folder', title: 'Mobile bookmarks', children: mobile })
  return { bar, other }
}

/** The pages visited, newest first. A place Firefox keeps out of its own history (reached only in a frame, or only as
 * a redirect on the way elsewhere) is `hidden`, with no visit counted, and is left out here as well. */
export function readFirefoxHistory (db: DatabaseSync, { limit, sinceMs }: HistoryReadOptions): HistoryImportRow[] {
  const rows = db.prepare(`
    SELECT url, title, visit_count AS visits, last_visit_date / 1000 AS millis FROM moz_places
    WHERE last_visit_date IS NOT NULL AND hidden = 0 AND visit_count > 0 AND last_visit_date / 1000 >= ? ORDER BY last_visit_date DESC LIMIT ?
  `).all(Math.max(sinceMs, 0), limit)
  const out: HistoryImportRow[] = []
  for (const row of rows) {
    const { url, title, visits, millis } = row as { url: unknown, title: unknown, visits: unknown, millis: unknown }
    if (typeof url !== 'string' || typeof millis !== 'number') continue
    out.push({ url, title: typeof title === 'string' ? title : '', lastVisit: millis, visitCount: typeof visits === 'number' && visits > 0 ? Math.trunc(visits) : 1 })
  }
  return out
}
