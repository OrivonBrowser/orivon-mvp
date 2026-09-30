// `StatementSync`: one prepared statement, bound and stepped synchronously.
// Values cross as Node's do: INTEGER is a number (a bigint when asked, and an
// out-of-range error when not), REAL a number, TEXT a string, BLOB a
// Uint8Array, NULL null. A JavaScript number always binds as REAL, as Node's.

import { codedError } from '../node-errors.js'
import type { Sqlite3 } from './engine.js'
import { invalidArgType, invalidArgValue, invalidState, outOfRange, sqliteError } from './errors.js'

export type SQLInputValue = null | number | bigint | string | ArrayBufferView
/** An anonymous parameter, or an object naming parameters. */
export type SQLParameter = SQLInputValue | Record<string, SQLInputValue>
export type SQLOutputValue = null | number | bigint | string | Uint8Array

/** A connection's shared state: what a statement needs from its database, and what closing the database must reach. */
export interface DatabaseState {
  readonly sqlite3: Sqlite3
  pointer: number
  readonly statements: Set<StatementState>
  readBigInts: boolean
  returnArrays: boolean
  allowBareNamedParameters: boolean
  allowUnknownNamedParameters: boolean
}

/** Held apart from the `StatementSync` object so a statement nobody references can be finalized after it is collected. */
export interface StatementState {
  readonly database: DatabaseState
  pointer: number
  readBigInts: boolean
  returnArrays: boolean
  allowBareNamedParameters: boolean
  allowUnknownNamedParameters: boolean
  bareNames?: Map<string, number>
}

const CONSTRUCT = Symbol('orivon.sqlite.statement')
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const INT64_MAX = 2n ** 63n - 1n
const INT64_MIN = -(2n ** 63n)
const SQLITE_ROW = 100
const SQLITE_DONE = 101
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Finalizes a statement whose `StatementSync` was collected, or that its database closed. */
export function finalizeStatement (state: StatementState): void {
  if (state.pointer === 0) return
  state.database.sqlite3.wasm.exports.sqlite3_finalize(state.pointer)
  state.pointer = 0
  state.database.statements.delete(state)
}

const collected = new FinalizationRegistry<StatementState>(finalizeStatement)
const states = new WeakMap<object, StatementState>()

function stateOf (statement: StatementSync): StatementState {
  const state = states.get(statement)
  if (state === undefined) throw invalidState('Illegal invocation')
  return state
}

function live (state: StatementState): StatementState {
  if (state.pointer === 0 || state.database.pointer === 0) throw invalidState('statement has been finalized')
  return state
}

function flag (value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw invalidArgType(`The "${name}" argument must be a boolean.`)
  return value
}

/** Prepares `sql`, tracked on `database`. An empty statement prepares to nothing, and every call on it says it is finalized, as Node's does. */
export function prepareStatement (database: DatabaseState, sql: string): StatementSync {
  const { sqlite3 } = database
  const { capi, wasm } = sqlite3
  const out = wasm.allocPtr()
  let pointer: number
  try {
    const rc = capi.sqlite3_prepare_v2(database.pointer, sql, -1, out, 0)
    if (rc !== 0) throw sqliteError(sqlite3, database.pointer)
    pointer = wasm.peekPtr(out)
  } finally {
    wasm.dealloc(out)
  }
  const state: StatementState = {
    database,
    pointer,
    readBigInts: database.readBigInts,
    returnArrays: database.returnArrays,
    allowBareNamedParameters: database.allowBareNamedParameters,
    allowUnknownNamedParameters: database.allowUnknownNamedParameters
  }
  if (pointer !== 0) database.statements.add(state)
  const statement = new StatementSync(CONSTRUCT)
  states.set(statement, state)
  collected.register(statement, state)
  return statement
}

function bindValue (state: StatementState, index: number, value: unknown): void {
  const { sqlite3, pointer: db } = state.database
  const { wasm } = sqlite3
  const { exports } = wasm
  const stmt = state.pointer
  let rc: number
  if (value === null) rc = exports.sqlite3_bind_null(stmt, index)
  else if (typeof value === 'number') rc = exports.sqlite3_bind_double(stmt, index, value)
  else if (typeof value === 'bigint') {
    if (value > INT64_MAX || value < INT64_MIN) throw invalidArgValue('BigInt value is too large to bind.')
    rc = exports.sqlite3_bind_int64(stmt, index, value)
  } else if (typeof value === 'string' || ArrayBuffer.isView(value)) {
    const bytes = typeof value === 'string' ? encoder.encode(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    if (typeof value !== 'string' && bytes.length === 0) rc = exports.sqlite3_bind_zeroblob(stmt, index, 0)
    else {
      const copy = wasm.alloc(Math.max(bytes.length, 1))
      wasm.heap8u().set(bytes, copy)
      const bind = typeof value === 'string' ? exports.sqlite3_bind_text : exports.sqlite3_bind_blob
      rc = bind(stmt, index, copy, bytes.length, sqlite3.capi.SQLITE_WASM_DEALLOC)
    }
  } else throw invalidArgType(`Provided value cannot be bound to SQLite parameter ${String(index)}.`)
  if (rc !== 0) throw sqliteError(sqlite3, db)
}

function bareIndex (state: StatementState, name: string): number {
  if (state.bareNames === undefined) {
    const { capi } = state.database.sqlite3
    state.bareNames = new Map()
    for (let i = 1, count = capi.sqlite3_bind_parameter_count(state.pointer); i <= count; i++) {
      const full = capi.sqlite3_bind_parameter_name(state.pointer, i)
      if (full !== null && !state.bareNames.has(full.slice(1))) state.bareNames.set(full.slice(1), i)
    }
  }
  return state.bareNames.get(name) ?? 0
}

function isNamedArgument (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !ArrayBuffer.isView(value)
}

/** Clears the last run's bindings, then binds `args`: an object binds named parameters, anything else the next `?` in order. */
function bindAll (state: StatementState, args: readonly unknown[]): void {
  const { capi, wasm } = state.database.sqlite3
  wasm.exports.sqlite3_reset(state.pointer)
  wasm.exports.sqlite3_clear_bindings(state.pointer)
  let anonymous = 1
  for (const arg of args) {
    if (isNamedArgument(arg)) {
      for (const key of Object.keys(arg)) {
        let index = capi.sqlite3_bind_parameter_index(state.pointer, key)
        if (index === 0 && state.allowBareNamedParameters) index = bareIndex(state, key)
        if (index === 0) {
          if (state.allowUnknownNamedParameters) continue
          throw invalidState(`Unknown named parameter '${key}'`)
        }
        bindValue(state, index, arg[key])
      }
    } else {
      while (capi.sqlite3_bind_parameter_name(state.pointer, anonymous) !== null) anonymous++
      bindValue(state, anonymous++, arg)
    }
  }
}

function readColumn (state: StatementState, column: number): SQLOutputValue {
  const { wasm } = state.database.sqlite3
  const { exports } = wasm
  const stmt = state.pointer
  switch (exports.sqlite3_column_type(stmt, column)) {
    case 1: {
      const value = exports.sqlite3_column_int64(stmt, column)
      if (state.readBigInts) return value
      if (value > MAX_SAFE || value < -MAX_SAFE) throw outOfRange(`Value is too large to be represented as a JavaScript number: ${String(value)}`)
      return Number(value)
    }
    case 2: return exports.sqlite3_column_double(stmt, column)
    case 3: {
      const pointer = exports.sqlite3_column_text(stmt, column)
      return decoder.decode(wasm.heap8u().subarray(pointer, pointer + exports.sqlite3_column_bytes(stmt, column)))
    }
    case 4: {
      const pointer = exports.sqlite3_column_blob(stmt, column)
      return wasm.heap8u().slice(pointer, pointer + exports.sqlite3_column_bytes(stmt, column))
    }
    default: return null
  }
}

function readRow (state: StatementState, names: readonly string[]): Record<string, SQLOutputValue> | SQLOutputValue[] {
  if (state.returnArrays) return names.map((_, column) => readColumn(state, column))
  const row: Record<string, SQLOutputValue> = Object.create(null)
  names.forEach((name, column) => { row[name] = readColumn(state, column) })
  return row
}

function columnNames (state: StatementState): string[] {
  const { capi } = state.database.sqlite3
  const names: string[] = []
  for (let i = 0, count = capi.sqlite3_column_count(state.pointer); i < count; i++) names.push(capi.sqlite3_column_name(state.pointer, i))
  return names
}

/** Steps once; anything but a row or completion is the statement's error, thrown after the statement is reset. */
function step (state: StatementState): number {
  const { sqlite3 } = state.database
  const rc = sqlite3.wasm.exports.sqlite3_step(state.pointer)
  if (rc === SQLITE_ROW || rc === SQLITE_DONE) return rc
  const error = sqliteError(sqlite3, state.database.pointer)
  sqlite3.wasm.exports.sqlite3_reset(state.pointer)
  throw error
}

export class StatementSync {
  constructor (token?: symbol) {
    if (token !== CONSTRUCT) throw codedError(Error, 'ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor')
  }

  get sourceSQL (): string {
    const state = live(stateOf(this))
    return state.database.sqlite3.capi.sqlite3_sql(state.pointer)
  }

  get expandedSQL (): string {
    const state = live(stateOf(this))
    return state.database.sqlite3.capi.sqlite3_expanded_sql(state.pointer)
  }

  run (...args: SQLParameter[]): { changes: number | bigint, lastInsertRowid: number | bigint } {
    const state = live(stateOf(this))
    bindAll(state, args)
    step(state)
    const { capi, wasm } = state.database.sqlite3
    wasm.exports.sqlite3_reset(state.pointer)
    const changes = capi.sqlite3_changes64(state.database.pointer)
    const lastInsertRowid = capi.sqlite3_last_insert_rowid(state.database.pointer)
    return state.readBigInts
      ? { changes: BigInt(changes), lastInsertRowid: BigInt(lastInsertRowid) }
      : { changes: Number(changes), lastInsertRowid: Number(lastInsertRowid) }
  }

  get (...args: SQLParameter[]): Record<string, SQLOutputValue> | SQLOutputValue[] | undefined {
    const state = live(stateOf(this))
    bindAll(state, args)
    try {
      return step(state) === SQLITE_ROW ? readRow(state, columnNames(state)) : undefined
    } finally {
      state.database.sqlite3.wasm.exports.sqlite3_reset(state.pointer)
    }
  }

  all (...args: SQLParameter[]): Array<Record<string, SQLOutputValue> | SQLOutputValue[]> {
    const state = live(stateOf(this))
    bindAll(state, args)
    const rows: Array<Record<string, SQLOutputValue> | SQLOutputValue[]> = []
    try {
      const names = columnNames(state)
      while (step(state) === SQLITE_ROW) rows.push(readRow(state, names))
      return rows
    } finally {
      state.database.sqlite3.wasm.exports.sqlite3_reset(state.pointer)
    }
  }

  iterate (...args: SQLParameter[]): IterableIterator<Record<string, SQLOutputValue> | SQLOutputValue[]> {
    const state = live(stateOf(this))
    bindAll(state, args)
    const names = columnNames(state)
    return (function * () {
      try {
        while (live(state) && step(state) === SQLITE_ROW) yield readRow(state, names)
      } finally {
        if (state.pointer !== 0) state.database.sqlite3.wasm.exports.sqlite3_reset(state.pointer)
      }
    })()
  }

  setReadBigInts (enabled: boolean): void { stateOf(this).readBigInts = flag(enabled, 'readBigInts') }
  setReturnArrays (enabled: boolean): void { stateOf(this).returnArrays = flag(enabled, 'returnArrays') }
  setAllowBareNamedParameters (enabled: boolean): void { stateOf(this).allowBareNamedParameters = flag(enabled, 'allowBareNamedParameters') }
  setAllowUnknownNamedParameters (enabled: boolean): void { stateOf(this).allowUnknownNamedParameters = flag(enabled, 'allowUnknownNamedParameters') }

  columns (): Array<Record<string, string | null>> {
    const state = live(stateOf(this))
    const { capi } = state.database.sqlite3
    const stmt = state.pointer
    return Array.from({ length: capi.sqlite3_column_count(stmt) }, (_, i) => {
      const column: Record<string, string | null> = Object.create(null)
      column.column = capi.sqlite3_column_origin_name(stmt, i)
      column.database = capi.sqlite3_column_database_name(stmt, i)
      column.name = capi.sqlite3_column_name(stmt, i)
      column.table = capi.sqlite3_column_table_name(stmt, i)
      column.type = capi.sqlite3_column_decltype(stmt, i)
      return column
    })
  }
}
