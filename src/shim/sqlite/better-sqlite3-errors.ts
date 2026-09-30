// The errors `better-sqlite3` throws, in its shapes: an SQLite failure is a
// `SqliteError` whose `code` is the extended result code's name
// (`SQLITE_CONSTRAINT_UNIQUE`); misuse is a `TypeError` or `RangeError`.

import { sqliteEngine } from './engine.js'

export class SqliteError extends Error {
  code: string

  constructor (message: string, code: string) {
    super(message)
    this.code = code
  }
}
Object.defineProperty(SqliteError.prototype, 'name', { value: 'SqliteError', writable: true, configurable: true })

const NOT_OPEN = 'The database connection is not open'

export function notOpen (): TypeError {
  return new TypeError(NOT_OPEN)
}

/** `error` as `better-sqlite3` reports it: the engine's failures as `SqliteError`, a closed database or statement as its `TypeError`, anything else unchanged. */
export function translate (error: unknown): unknown {
  const { code, errcode, message } = error as { code?: unknown, errcode?: unknown, message?: unknown }
  if (code === 'ERR_SQLITE_ERROR' && typeof errcode === 'number' && typeof message === 'string') {
    return new SqliteError(message, sqliteEngine().capi.sqlite3_js_rc_str(errcode) ?? `UNKNOWN_SQLITE_ERROR_${String(errcode)}`)
  }
  if (code === 'ERR_INVALID_STATE' && (message === 'database is not open' || message === 'statement has been finalized')) return notOpen()
  return error
}

export function guarded<T> (call: () => T): T {
  try {
    return call()
  } catch (error) {
    throw translate(error)
  }
}
