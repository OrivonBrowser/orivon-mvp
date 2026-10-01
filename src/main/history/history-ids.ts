// Pages named by id, for what the History page does to rows it has selected: open them, copy them, forget them.
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { LIST_COLUMNS, toEntry } from './history-list.js'
import type { Row } from './history-list.js'
import type { HistoryEntry } from './history-store.js'

/** The most ids one call names. */
export const MAX_IDS = 500

const prepared = new WeakMap<DatabaseSync, { select: StatementSync, remove: StatementSync }>()

// The ids travel as one JSON array, so each statement is prepared once whatever their number.
/** Prepares the statements of this module once, so a read never has to. */
export function prepareIdStatements (db: DatabaseSync): { select: StatementSync, remove: StatementSync } {
  let found = prepared.get(db)
  if (found === undefined) {
    found = {
      select: db.prepare(`SELECT ${LIST_COLUMNS} FROM pages WHERE id IN (SELECT value FROM json_each(?))`),
      remove: db.prepare('DELETE FROM pages WHERE id IN (SELECT value FROM json_each(?))')
    }
    prepared.set(db, found)
  }
  return found
}

const distinct = (ids: readonly number[]): number[] => [...new Set(ids.filter((id) => Number.isInteger(id)))].slice(0, MAX_IDS)

/** The pages with these ids, in the order the ids were given; an id with no page is skipped. */
export function pagesByIds (db: DatabaseSync, ids: readonly number[]): HistoryEntry[] {
  const wanted = distinct(ids)
  if (wanted.length === 0) return []
  const rows = prepareIdStatements(db).select.all(JSON.stringify(wanted)) as unknown as Row[]
  const byId = new Map(rows.map((row) => [row.id, toEntry(row)]))
  return wanted.flatMap((id) => byId.get(id) ?? [])
}

/** Deletes the pages with these ids. The caller wraps it in the transaction that also forgets their icons. */
export function deletePagesByIds (db: DatabaseSync, ids: readonly number[]): number {
  const wanted = distinct(ids)
  if (wanted.length === 0) return 0
  return Number(prepareIdStatements(db).remove.run(JSON.stringify(wanted)).changes)
}
