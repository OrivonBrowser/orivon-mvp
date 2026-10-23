// `DatabaseSync`: a connection to an SQLite database, held in the engine's
// memory (`:memory:`, or an empty name) or in a file of the app's own files
// (vfs.ts). Everything is synchronous, as Node's is.

import { installOrivonVfs, ORIVON_VFS_NAME } from './vfs.js'
import { sqliteEngine, type Sqlite3 } from './engine.js'
import { invalidArgType, invalidState, sqliteError, unbuilt } from './errors.js'
import { orivonSqliteFiles } from './files.js'
import { defineScalarFunction, type ScalarFunction } from './functions.js'
import { failureOf, finalizeStatement, prepareStatement, type DatabaseState, type StatementSync } from './statement.js'

export interface DatabaseSyncOptions {
  open?: boolean
  readOnly?: boolean
  enableForeignKeyConstraints?: boolean
  enableDoubleQuotedStringLiterals?: boolean
  allowExtension?: boolean
  timeout?: number
  readBigInts?: boolean
  returnArrays?: boolean
  allowBareNamedParameters?: boolean
  allowUnknownNamedParameters?: boolean
  defensive?: boolean
}

const OPEN_READONLY = 0x1
const OPEN_READWRITE = 0x2
const OPEN_CREATE = 0x4
const DBCONFIG_ENABLE_FKEY = 1002
const DBCONFIG_DEFENSIVE = 1010
const DBCONFIG_DQS_DML = 1013
const DBCONFIG_DQS_DDL = 1014
// sqlite3_deserialize's flags; the package exports no constant for them.
const DESERIALIZE_FREEONCLOSE = 1
const DESERIALIZE_RESIZEABLE = 2
const DESERIALIZE_READONLY = 4
const SQLITE_NOMEM = 7

const states = new WeakMap<object, DatabaseState>()
const forgotten = new FinalizationRegistry<DatabaseState>((state) => { closeState(state) })

function pathText (path: unknown): string {
  const text = path instanceof URL
    ? (path.protocol === 'file:' ? decodeURIComponent(path.pathname) : undefined)
    : path instanceof Uint8Array ? new TextDecoder().decode(path) : path
  if (typeof text !== 'string' || text.includes('\0')) {
    throw invalidArgType('The "path" argument must be a string, Uint8Array, or URL without null bytes.')
  }
  return text
}

function booleanOption (options: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = options[name]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw invalidArgType(`The "options.${name}" argument must be a boolean.`)
  return value
}

/** Finalizes every statement and closes the connection. Idempotent: the state is what a collected `DatabaseSync` leaves behind. */
function closeState (state: DatabaseState): void {
  if (state.pointer === 0) return
  for (const statement of [...state.statements]) finalizeStatement(statement)
  state.sqlite3.capi.sqlite3_close_v2(state.pointer)
  state.pointer = 0
}

function live (state: DatabaseState): DatabaseState {
  if (state.pointer === 0) throw invalidState('database is not open')
  return state
}

/** Turns a connection setting on or off, throwing the connection's own error when the engine refuses. */
function configure (sqlite3: Sqlite3, db: number, setting: number, enabled: boolean): void {
  if (sqlite3.capi.sqlite3_db_config(db, setting, enabled ? 1 : 0, 0) !== 0) throw sqliteError(sqlite3, db)
}

/** Registers a scalar function on an open `database` under `definition`'s rules: the route the `better-sqlite3` adapter takes, since its options and value rules are not Node's. */
export function registerScalarFunction (database: DatabaseSync, definition: ScalarFunction): void {
  const state = states.get(database)
  if (state === undefined) throw invalidState('Illegal invocation')
  defineScalarFunction(live(state), definition)
}

/** The bytes of the database `schema` of an open `database`, as SQLite would write its file: the route for a database in memory, which no VFS serves. */
export function exportDatabase (database: DatabaseSync, schema: string): Uint8Array {
  const state = states.get(database)
  if (state === undefined) throw invalidState('Illegal invocation')
  const { sqlite3, pointer } = live(state)
  if (state.running > 0) throw invalidState('database is busy: a user-defined function is running on it')
  return sqlite3.capi.sqlite3_js_db_export(pointer, schema)
}

/**
 * Makes `bytes`, the image of a database file, the content of the empty in-memory database `database`. The engine
 * takes a copy into its own memory and frees it when the connection closes, so the caller's buffer is neither kept
 * nor changed, and no file is read or written. Bytes that are not a database are not checked here: the first
 * statement fails with SQLite's "file is not a database", as it does for a file.
 */
export function importDatabase (database: DatabaseSync, bytes: Uint8Array, readOnly: boolean): void {
  const state = states.get(database)
  if (state === undefined) throw invalidState('Illegal invocation')
  const { sqlite3, pointer } = live(state)
  if (database.location() !== null) throw invalidState('only a database in memory can be loaded from bytes')
  const { capi, wasm } = sqlite3
  // An empty image is an empty database; the engine cannot be handed a zero-length allocation.
  let copy: number
  try {
    copy = wasm.alloc(Math.max(bytes.length, 1))
  } catch {
    throw Object.assign(new Error('out of memory'), { code: 'ERR_SQLITE_ERROR' as const, errcode: SQLITE_NOMEM, errstr: capi.sqlite3_errstr(SQLITE_NOMEM) })
  }
  wasm.heap8u().set(bytes, copy)
  // The engine owns the copy from here, and frees it even when it refuses.
  const rc = capi.sqlite3_deserialize(pointer, 'main', copy, bytes.length, Math.max(bytes.length, 1), DESERIALIZE_FREEONCLOSE | (readOnly ? DESERIALIZE_READONLY : DESERIALIZE_RESIZEABLE))
  if (rc !== 0) throw sqliteError(sqlite3, pointer)
}

export class DatabaseSync {
  readonly #location: string
  readonly #readOnly: boolean
  readonly #foreignKeys: boolean
  readonly #doubleQuotes: boolean
  readonly #defensive: boolean
  readonly #timeout: number

  constructor (path: string | Uint8Array | URL, options: DatabaseSyncOptions = {}) {
    const location = pathText(path)
    if (typeof options !== 'object' || options === null) throw invalidArgType('The "options" argument must be an object.')
    const settings = options as Record<string, unknown>
    if (booleanOption(settings, 'allowExtension', false)) throw unbuilt('DatabaseSync', 'extensions are WebAssembly-only here and cannot be loaded')
    const timeout = settings.timeout ?? 0
    if (typeof timeout !== 'number' || !Number.isInteger(timeout)) throw invalidArgType('The "options.timeout" argument must be an integer.')
    this.#location = location
    this.#readOnly = booleanOption(settings, 'readOnly', false)
    this.#foreignKeys = booleanOption(settings, 'enableForeignKeyConstraints', true)
    this.#doubleQuotes = booleanOption(settings, 'enableDoubleQuotedStringLiterals', false)
    this.#defensive = booleanOption(settings, 'defensive', false)
    this.#timeout = timeout
    const shouldOpen = booleanOption(settings, 'open', true)
    states.set(this, {
      sqlite3: undefined as unknown as Sqlite3,
      pointer: 0,
      statements: new Set(),
      running: 0,
      readBigInts: booleanOption(settings, 'readBigInts', false),
      returnArrays: booleanOption(settings, 'returnArrays', false),
      allowBareNamedParameters: booleanOption(settings, 'allowBareNamedParameters', true),
      allowUnknownNamedParameters: booleanOption(settings, 'allowUnknownNamedParameters', false)
    })
    if (shouldOpen) this.open()
  }

  #state (): DatabaseState {
    const state = states.get(this)
    if (state === undefined) throw invalidState('Illegal invocation')
    return state
  }

  open (): void {
    const state = this.#state()
    if (state.pointer !== 0) throw invalidState('database is already open')
    const sqlite3 = sqliteEngine()
    const { capi, wasm } = sqlite3
    const inEngineMemory = this.#location === ':memory:' || this.#location === ''
    if (!inEngineMemory) {
      orivonSqliteFiles()
      installOrivonVfs(sqlite3)
    }
    const flags = this.#readOnly ? OPEN_READONLY : OPEN_READWRITE | OPEN_CREATE
    const out = wasm.allocPtr()
    let db: number
    try {
      const rc = capi.sqlite3_open_v2(this.#location, out, flags, inEngineMemory ? null as never : ORIVON_VFS_NAME)
      db = wasm.peekPtr(out)
      if (rc !== 0) {
        const error = sqliteError(sqlite3, db)
        if (db !== 0) capi.sqlite3_close_v2(db)
        throw error
      }
    } finally {
      wasm.dealloc(out)
    }
    try {
      configure(sqlite3, db, DBCONFIG_ENABLE_FKEY, this.#foreignKeys)
      configure(sqlite3, db, DBCONFIG_DQS_DML, this.#doubleQuotes)
      configure(sqlite3, db, DBCONFIG_DQS_DDL, this.#doubleQuotes)
      if (this.#defensive) configure(sqlite3, db, DBCONFIG_DEFENSIVE, true)
      capi.sqlite3_busy_timeout(db, this.#timeout)
    } catch (error) {
      capi.sqlite3_close_v2(db)
      throw error
    }
    Object.assign(state, { sqlite3, pointer: db })
    forgotten.register(this, state, state)
  }

  close (): void {
    const state = live(this.#state())
    if (state.running > 0) throw invalidState('database is busy: a user-defined function is running on it')
    forgotten.unregister(state)
    closeState(state)
  }

  get isOpen (): boolean {
    return this.#state().pointer !== 0
  }

  get isTransaction (): boolean {
    const state = live(this.#state())
    return state.sqlite3.capi.sqlite3_get_autocommit(state.pointer) === 0
  }

  location (dbName = 'main'): string | null {
    const state = live(this.#state())
    const name = state.sqlite3.capi.sqlite3_db_filename(state.pointer, dbName)
    return typeof name === 'string' && name !== '' ? name : null
  }

  exec (sql: string): void {
    const state = live(this.#state())
    if (typeof sql !== 'string') throw invalidArgType('The "sql" argument must be a string.')
    state.thrown = undefined
    if (state.sqlite3.capi.sqlite3_exec(state.pointer, sql, 0, 0, 0) !== 0) throw failureOf(state)
  }

  prepare (sql: string): StatementSync {
    const state = live(this.#state())
    if (typeof sql !== 'string') throw invalidArgType('The "sql" argument must be a string.')
    return prepareStatement(this, state, sql)
  }

  enableDefensive (active: boolean): void {
    const state = live(this.#state())
    if (typeof active !== 'boolean') throw invalidArgType('The "active" argument must be a boolean.')
    configure(state.sqlite3, state.pointer, DBCONFIG_DEFENSIVE, active)
  }

  [Symbol.dispose] (): void {
    if (this.isOpen) this.close()
  }

  function (name: unknown, ...rest: unknown[]): void {
    const state = live(this.#state())
    if (typeof name !== 'string') throw invalidArgType('The "name" argument must be a string.')
    const [second, third] = rest
    const fn = typeof second === 'function' ? second : third
    let options: Record<string, unknown> = {}
    if (typeof second !== 'function' && !(second === undefined && fn === undefined)) {
      if (typeof second !== 'object' || second === null) throw invalidArgType('The "options" argument must be an object.')
      options = second as Record<string, unknown>
    }
    if (typeof fn !== 'function') throw invalidArgType('The "function" argument must be a function.')
    const useBigIntArguments = booleanOption(options, 'useBigIntArguments', false)
    const varargs = booleanOption(options, 'varargs', false)
    defineScalarFunction(state, {
      name,
      argc: varargs ? -1 : fn.length,
      deterministic: booleanOption(options, 'deterministic', false),
      directOnly: booleanOption(options, 'directOnly', false),
      integers: () => useBigIntArguments ? 'bigint' : 'checked',
      rules: 'node',
      fn: (...args) => Reflect.apply(fn, undefined, args) as unknown
    })
  }

  aggregate (): never { throw unbuilt('DatabaseSync.aggregate', 'user-defined aggregate functions are not built') }
  createSession (): never { throw unbuilt('DatabaseSync.createSession', 'the package exposes no session API') }
  applyChangeset (): never { throw unbuilt('DatabaseSync.applyChangeset', 'the package exposes no session API') }
  createTagStore (): never { throw unbuilt('DatabaseSync.createTagStore', 'SQL tag stores are not built') }
  loadExtension (): never { throw unbuilt('DatabaseSync.loadExtension', 'a native extension cannot be loaded into WebAssembly') }
  enableLoadExtension (): never { throw unbuilt('DatabaseSync.enableLoadExtension', 'a native extension cannot be loaded into WebAssembly') }
}
