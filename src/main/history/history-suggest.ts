// What the address bar offers from history while someone types, and the count of addresses typed in full.
// Both read and write the store's own `pages` table, which the caller has brought up to date first.
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { likePattern } from './history-list.js'
import type { HistorySuggestion } from './history-store.js'

/** More words than this are not looked for: each is one more condition on every row. */
const MAX_TERMS = 4
const MAX_TERM_LENGTH = 200

type Row = { url: string, title: string, visit_count: number, typed_count: number, last_visit: number }

/** One statement per number of words, prepared when first needed and kept with its database. */
const statements = new WeakMap<DatabaseSync, Map<number, StatementSync>>()

function statementFor (db: DatabaseSync, terms: number): StatementSync {
  let byTerms = statements.get(db)
  if (byTerms === undefined) {
    byTerms = new Map()
    statements.set(db, byTerms)
  }
  let statement = byTerms.get(terms)
  if (statement === undefined) {
    const condition = "(url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')"
    statement = db.prepare(`
      SELECT url, title, visit_count, typed_count, last_visit FROM pages
      WHERE ${Array.from({ length: terms }, () => condition).join(' AND ')}
      ORDER BY typed_count DESC, visit_count DESC, last_visit DESC LIMIT ?
    `)
    byTerms.set(terms, statement)
  }
  return statement
}

/** Pages whose address or title contain every word of the text, the most typed, then most visited, then most recent first. */
export function suggestPages (db: DatabaseSync, text: string, limit: number): HistorySuggestion[] {
  const terms = text.trim().split(/\s+/).filter((term) => term !== '').slice(0, MAX_TERMS).map((term) => term.slice(0, MAX_TERM_LENGTH))
  if (terms.length === 0 || limit < 1) return []
  const patterns = terms.flatMap((term) => { const pattern = likePattern(term); return [pattern, pattern] })
  const rows = statementFor(db, terms.length).all(...patterns, Math.trunc(limit)) as unknown as Row[]
  return rows.map((row) => ({
    url: row.url, title: row.title, visitCount: row.visit_count, typedCount: row.typed_count, lastVisit: row.last_visit
  }))
}

const typed = new WeakMap<DatabaseSync, StatementSync>()

/** Counts the address as typed in full. True when the page was there to count it on. */
export function markPageTyped (db: DatabaseSync, url: string): boolean {
  let statement = typed.get(db)
  if (statement === undefined) {
    statement = db.prepare('UPDATE pages SET typed_count = typed_count + 1 WHERE url = ?')
    typed.set(db, statement)
  }
  return Number(statement.run(url).changes) > 0
}
