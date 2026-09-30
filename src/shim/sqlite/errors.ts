// The errors `node:sqlite` throws, in Node's shapes: an SQLite failure is an
// `Error` with `code: 'ERR_SQLITE_ERROR'`, the extended result code as
// `errcode` and SQLite's own text for it as `errstr`; misuse is a Node
// `ERR_*` error of the right class.

import { codedError } from '../node-errors.js'
import { refuseShim, type OrivonShimError } from '../errors.js'
import type { Sqlite3 } from './engine.js'

export interface SqliteError extends Error {
  code: 'ERR_SQLITE_ERROR'
  errcode: number
  errstr: string
}

/** What `db` last failed with, as Node reports it. `db` is the connection pointer. */
export function sqliteError (sqlite3: Sqlite3, db: number, message?: string): SqliteError {
  const { capi } = sqlite3
  const errcode = db === 0 ? capi.SQLITE_ERROR : capi.sqlite3_extended_errcode(db)
  const text = message ?? (db === 0 ? capi.sqlite3_errstr(errcode) : capi.sqlite3_errmsg(db))
  return Object.assign(new Error(text), {
    code: 'ERR_SQLITE_ERROR' as const,
    errcode,
    errstr: capi.sqlite3_errstr(errcode)
  })
}

export const invalidState = (message: string): Error & { code: string } => codedError(Error, 'ERR_INVALID_STATE', message)
export const invalidArgType = (message: string): TypeError & { code: string } => codedError(TypeError, 'ERR_INVALID_ARG_TYPE', message)
export const invalidArgValue = (message: string): TypeError & { code: string } => codedError(TypeError, 'ERR_INVALID_ARG_VALUE', message)
export const outOfRange = (message: string): RangeError & { code: string } => codedError(RangeError, 'ERR_OUT_OF_RANGE', message)

/** A `node:sqlite` member this shim has not built. */
export function unbuilt (api: string, why: string): OrivonShimError {
  return refuseShim(`sqlite.${api}`, 'not-built', `sqlite.${api} is not built: ${why}. See src/shim/sqlite/README.md`)
}
