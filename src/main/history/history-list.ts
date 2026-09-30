// Listing pages, most recently visited first, with an optional search. A search of three characters or more
// probes how many rows a trigram FTS5 index would return for it: a sparse term is read through that index, a
// dense one (a common substring like "https://") through the LIKE scan instead, which walks the last-visit
// index and can stop at one page rather than gathering every match first. LIKE is the one definition of
// "matches"; MATCH only narrows the candidates, so either path returns the same rows.
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './history-store.js'
import type { HistoryEntry, HistoryQuery } from './history-store.js'

/** Below this, the trigram index cannot resolve a match, so `list` keeps the plain `LIKE` scan. */
const FTS_MIN_SEARCH_LENGTH = 3
/** A term this common or more (probed before every FTS search) reads through `LIKE` instead: MATCH would
 * gather most of the table before ORDER BY/LIMIT could cut it off, where LIKE walks the last-visit index
 * and stops at one page. */
export const FTS_DENSITY_LIMIT = 500

export interface Row { id: number, url: string, title: string, last_visit: number, visit_count: number }

export const toEntry = (row: Row): HistoryEntry => ({ id: row.id, url: row.url, title: row.title, lastVisit: row.last_visit, visitCount: row.visit_count })

/** Escapes what LIKE would read as a pattern. */
export const likePattern = (text: string): string => `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`

/** Escapes what FTS5's query syntax would read as a phrase delimiter, so `search` is matched
 * as the literal text it is -- never as MATCH syntax (AND, OR, NOT, column filters, `*`). */
const ftsPhrase = (text: string): string => `"${text.replace(/"/g, '""')}"`

const LIST_COLUMNS = 'id, url, title, last_visit, visit_count'
const LIST_ORDER = 'ORDER BY last_visit DESC, id DESC LIMIT ?'
const AFTER_CONDITION = '(last_visit < ? OR (last_visit = ? AND id < ?))'
const LIKE_CONDITION = "(title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\')"
/** Same as `LIKE_CONDITION`, aliased for the FTS join: MATCH only narrows candidates fast (and folds case
 * for Unicode, where LIKE folds only ASCII), so LIKE stays the one definition of "matches" either way. */
const LIKE_CONDITION_P = "(p.title LIKE ? ESCAPE '\\' OR p.url LIKE ? ESCAPE '\\')"

/** One statement per WHERE shape `list` can need: with or without `after`, and none/LIKE/FTS for `search`;
 * and the probe of how many rows (up to the density limit) a trigram search would return. */
export interface ListStatements {
  plain: StatementSync
  after: StatementSync
  like: StatementSync
  likeAfter: StatementSync
  fts: StatementSync
  ftsAfter: StatementSync
  densityProbe: StatementSync
}

export function prepareListStatements (db: DatabaseSync, densityLimit: number): ListStatements {
  return {
    plain: db.prepare(`SELECT ${LIST_COLUMNS} FROM pages ${LIST_ORDER}`),
    after: db.prepare(`SELECT ${LIST_COLUMNS} FROM pages WHERE ${AFTER_CONDITION} ${LIST_ORDER}`),
    like: db.prepare(`SELECT ${LIST_COLUMNS} FROM pages WHERE ${LIKE_CONDITION} ${LIST_ORDER}`),
    likeAfter: db.prepare(`SELECT ${LIST_COLUMNS} FROM pages WHERE ${AFTER_CONDITION} AND ${LIKE_CONDITION} ${LIST_ORDER}`),
    fts: db.prepare(`
      SELECT p.id, p.url, p.title, p.last_visit, p.visit_count FROM pages p
      JOIN pages_fts f ON f.rowid = p.id WHERE pages_fts MATCH ? AND ${LIKE_CONDITION_P}
      ORDER BY p.last_visit DESC, p.id DESC LIMIT ?
    `),
    ftsAfter: db.prepare(`
      SELECT p.id, p.url, p.title, p.last_visit, p.visit_count FROM pages p
      JOIN pages_fts f ON f.rowid = p.id
      WHERE (p.last_visit < ? OR (p.last_visit = ? AND p.id < ?)) AND pages_fts MATCH ? AND ${LIKE_CONDITION_P}
      ORDER BY p.last_visit DESC, p.id DESC LIMIT ?
    `),
    densityProbe: db.prepare(`SELECT COUNT(*) AS n FROM (SELECT rowid FROM pages_fts WHERE pages_fts MATCH ? LIMIT ${String(densityLimit)})`)
  }
}

/** The page of entries `query` asks for. The caller has written what was waiting, so the answer is never behind. */
export function listPages (statements: ListStatements, densityLimit: number, query: HistoryQuery): HistoryEntry[] {
  const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? DEFAULT_PAGE_SIZE)), MAX_PAGE_SIZE)
  const after = query.after
  const search = query.search?.trim() ?? ''
  let rows: Row[]
  // The trigram tokenizer needs three actual characters; [...search].length counts those (Unicode code
  // points), where search.length counts UTF-16 code units and over-counts any character outside the
  // Basic Multilingual Plane (a surrogate pair, such as most emoji, counts as two).
  if ([...search].length >= FTS_MIN_SEARCH_LENGTH) {
    const term = ftsPhrase(search)
    const pattern = likePattern(search)
    rows = isDense(statements, densityLimit, term) ? queryLike(statements, pattern, after, limit) : queryFts(statements, term, pattern, after, limit)
  } else if (search !== '') {
    rows = queryLike(statements, likePattern(search), after, limit)
  } else {
    rows = (after === undefined
      ? statements.plain.all(limit)
      : statements.after.all(after.lastVisit, after.lastVisit, after.id, limit)) as unknown as Row[]
  }
  return rows.map(toEntry)
}

/** Whether `term` (an already-escaped FTS phrase) would return `densityLimit` rows or more: too many
 * for MATCH's join to sort and cut off with LIMIT as cheaply as the LIKE scan, which stops at one page.
 * Ignores `after`: it estimates how common the term is, not how many pages of it remain. */
function isDense (statements: ListStatements, densityLimit: number, term: string): boolean {
  return (statements.densityProbe.get(term) as { n: number }).n >= densityLimit
}

function queryLike (statements: ListStatements, pattern: string, after: HistoryQuery['after'], limit: number): Row[] {
  return (after === undefined
    ? statements.like.all(pattern, pattern, limit)
    : statements.likeAfter.all(after.lastVisit, after.lastVisit, after.id, pattern, pattern, limit)) as unknown as Row[]
}

/** `pattern` is bound after the MATCH term: MATCH narrows fast, LIKE (ASCII-only case fold) is the actual
 * definition of "matches" it must also satisfy, so a search agrees with `queryLike` however dense it is. */
function queryFts (statements: ListStatements, term: string, pattern: string, after: HistoryQuery['after'], limit: number): Row[] {
  return (after === undefined
    ? statements.fts.all(term, pattern, pattern, limit)
    : statements.ftsAfter.all(after.lastVisit, after.lastVisit, after.id, term, pattern, pattern, limit)) as unknown as Row[]
}
