// `better-sqlite3`'s synchronous API over `DatabaseSync`, so code written for
// that package runs unchanged. Imported as `better-sqlite3` by a bundle whose
// build points that name here (README.md); the `sqlite/ready.ts` rule of
// `node:sqlite` applies: the engine must have loaded before `new Database()`.

import { refuseShim } from '../errors.js'
import { DatabaseSync, registerScalarFunction } from './database.js'
import type { FunctionValue, ScalarFunction } from './functions.js'
import { backupDatabase, type BackupInfo } from './better-sqlite3-backup.js'
import { orivonSqliteFiles } from './files.js'
import { Statement, type StatementHost } from './better-sqlite3-statement.js'
import { guarded, notOpen, SqliteError } from './better-sqlite3-errors.js'

export { SqliteError }
export type { Statement }

export interface DatabaseOptions {
  readonly?: boolean
  fileMustExist?: boolean
  timeout?: number
  verbose?: ((message?: unknown, ...additionalArgs: unknown[]) => void) | null
  /** Accepted and ignored: there is no native addon to locate. */
  nativeBinding?: unknown
}

export type TransactionFunction<F extends (...args: never[]) => unknown> = F & {
  readonly default: TransactionFunction<F>
  readonly deferred: TransactionFunction<F>
  readonly immediate: TransactionFunction<F>
  readonly exclusive: TransactionFunction<F>
  readonly database: Database
}

const MAX_TIMEOUT = 0x7fffffff

function unbuilt (member: string, why: string): never {
  const api = `better-sqlite3.Database.${member}`
  throw refuseShim(api, 'not-built', `${api} is not built: ${why}. See src/shim/sqlite/README.md`)
}

function option (options: DatabaseOptions, name: 'readonly' | 'fileMustExist'): boolean {
  const value = options[name] as unknown
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw new TypeError(`Expected the "${name}" option to be a boolean`)
  return value
}

function booleanOption (options: Record<string, unknown>, name: string): boolean {
  const value = name in options ? options[name] : false
  if (typeof value !== 'boolean') throw new TypeError(`Expected the "${name}" option to be a boolean`)
  return value
}

type ScalarBody = (...args: FunctionValue[]) => unknown

/**
 * The function `db.function(name, options, fn)` registers, checked as `better-sqlite3` checks it. Built outside the
 * class and given the defaults object alone: the engine keeps the callbacks for as long as the connection is open, and
 * a closure made beside one that uses `this` would share its context and keep the database from being collected.
 */
function scalarFunction (name: string, options: Record<string, unknown>, fn: ScalarBody, defaults: { safeIntegers: boolean }): ScalarFunction {
  if (name === '') throw new TypeError('User-defined function name cannot be an empty string')
  const ownIntegers = 'safeIntegers' in options ? booleanOption(options, 'safeIntegers') : undefined
  const deterministic = booleanOption(options, 'deterministic')
  const directOnly = booleanOption(options, 'directOnly')
  let argc = -1
  if (!booleanOption(options, 'varargs')) {
    argc = fn.length
    if (argc > 100) throw new RangeError('User-defined functions cannot have more than 100 arguments')
  }
  return {
    name,
    argc,
    deterministic,
    directOnly,
    integers: () => (ownIntegers ?? defaults.safeIntegers) ? 'bigint' : 'lossy',
    rules: 'better-sqlite3',
    fn: (...args) => Reflect.apply(fn, undefined, args) as unknown
  }
}

function toggleOf (toggle: unknown): boolean {
  if (toggle === undefined) return true
  if (typeof toggle !== 'boolean') throw new TypeError('Expected first argument to be a boolean')
  return toggle
}

class DatabaseImpl {
  static readonly SqliteError = SqliteError

  readonly name: string
  readonly memory: boolean
  readonly readonly: boolean
  readonly #inner: DatabaseSync
  readonly #verbose: ((message?: unknown, ...additionalArgs: unknown[]) => void) | null
  readonly #host: StatementHost
  readonly #defaults = { safeIntegers: false }

  constructor (filenameGiven?: string, options?: DatabaseOptions) {
    if (filenameGiven !== undefined && filenameGiven !== null && typeof filenameGiven !== 'string') {
      if (ArrayBuffer.isView(filenameGiven)) unbuilt('constructor', 'opening a database from a Buffer needs serialize and deserialize, which are not built')
      throw new TypeError('Expected first argument to be a string')
    }
    const settings: DatabaseOptions = options ?? {}
    if (typeof settings !== 'object') throw new TypeError('Expected second argument to be an options object')
    if ('readOnly' in settings) throw new TypeError('Misspelled option "readOnly" should be "readonly"')
    if ('memory' in settings) throw new TypeError('Option "memory" was removed in v7.0.0 (use ":memory:" filename instead)')
    const filename = (filenameGiven ?? '').trim()
    const anonymous = filename === '' || filename === ':memory:'
    const readonly = option(settings, 'readonly')
    const fileMustExist = option(settings, 'fileMustExist')
    const timeout = settings.timeout ?? 5000
    const verbose = settings.verbose ?? null
    if (readonly && anonymous) throw new TypeError('In-memory/temporary databases cannot be readonly')
    if (!Number.isInteger(timeout) || timeout < 0) throw new TypeError('Expected the "timeout" option to be a positive integer')
    if (timeout > MAX_TIMEOUT) throw new RangeError('Option "timeout" cannot be greater than 2147483647')
    if (verbose !== null && typeof verbose !== 'function') throw new TypeError('Expected the "verbose" option to be a function')
    if (settings.nativeBinding != null && typeof settings.nativeBinding !== 'string' && typeof settings.nativeBinding !== 'object') {
      throw new TypeError('Expected the "nativeBinding" option to be a string or addon object')
    }
    if (fileMustExist && !anonymous && !orivonSqliteFiles().exists(filename)) throw new SqliteError('unable to open database file', 'SQLITE_CANTOPEN')
    this.name = filenameGiven ?? ''
    this.memory = anonymous
    this.readonly = readonly
    this.#verbose = verbose
    this.#inner = guarded(() => new DatabaseSync(filename, { readOnly: readonly, timeout }))
    this.#host = {
      database: this,
      isOpen: () => this.#inner.isOpen,
      trace: (sql) => { this.#verbose?.(sql()) }
    }
  }

  get open (): boolean {
    return this.#inner.isOpen
  }

  get inTransaction (): boolean {
    return this.#inner.isOpen && this.#inner.isTransaction
  }

  #prepare (source: unknown, pragma: boolean): Statement {
    if (typeof source !== 'string') throw new TypeError('Expected first argument to be a string')
    if (!this.#inner.isOpen) throw notOpen()
    let inner
    try {
      inner = guarded(() => this.#inner.prepare(source))
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ERR_INVALID_ARG_VALUE') throw new RangeError('The supplied SQL string contains no statements')
      throw error
    }
    return new Statement(this.#host, inner, source, this.#defaults.safeIntegers, pragma)
  }

  prepare (source: string): Statement {
    return this.#prepare(source, false)
  }

  exec (source: string): this {
    if (typeof source !== 'string') throw new TypeError('Expected first argument to be a string')
    if (!this.#inner.isOpen) throw notOpen()
    try {
      guarded(() => { this.#inner.exec(source) })
    } finally {
      this.#host.trace(() => source)
    }
    return this
  }

  pragma (source: string, options?: { simple?: boolean }): unknown {
    if (typeof source !== 'string') throw new TypeError('Expected first argument to be a string')
    if (options !== undefined && options !== null && typeof options !== 'object') throw new TypeError('Expected second argument to be an options object')
    const simple = options?.simple
    if (simple !== undefined && typeof simple !== 'boolean') throw new TypeError('Expected the "simple" option to be a boolean')
    const statement = this.#prepare(`PRAGMA ${source}`, true)
    return simple === true ? statement.pluck().get() : statement.all()
  }

  transaction<F extends (...args: never[]) => unknown> (fn: F): TransactionFunction<F> {
    if (typeof fn !== 'function') throw new TypeError('Expected first argument to be a function')
    const savepoint = `\`_bs3.${Math.random().toString(36).slice(2)}\``
    const variants = (begin: string): TransactionFunction<F> => {
      const self = this
      return function sqliteTransaction (this: unknown, ...args: unknown[]) {
        const nested = self.inTransaction
        self.exec(nested ? `SAVEPOINT ${savepoint}` : begin)
        try {
          const result = Reflect.apply(fn, this, args) as unknown
          if (typeof (result as { then?: unknown } | null | undefined)?.then === 'function') throw new TypeError('Transaction function cannot return a promise')
          self.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT')
          return result
        } catch (error) {
          if (self.inTransaction) {
            self.exec(nested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK')
            if (nested) self.exec(`RELEASE ${savepoint}`)
          }
          throw error
        }
      } as unknown as TransactionFunction<F>
    }
    const made = variants('BEGIN')
    const properties = {
      default: { value: made },
      deferred: { value: variants('BEGIN DEFERRED') },
      immediate: { value: variants('BEGIN IMMEDIATE') },
      exclusive: { value: variants('BEGIN EXCLUSIVE') },
      database: { value: this, enumerable: true }
    }
    Object.defineProperties(made, properties)
    for (const name of ['deferred', 'immediate', 'exclusive'] as const) Object.defineProperties(made[name], properties)
    return made
  }

  close (): this {
    if (this.#inner.isOpen) guarded(() => { this.#inner.close() })
    return this
  }

  defaultSafeIntegers (toggle?: boolean): this {
    this.#defaults.safeIntegers = toggleOf(toggle)
    return this
  }

  unsafeMode (toggle?: boolean): this {
    toggleOf(toggle)
    return this
  }

  function (name: unknown, optionsOrFunction?: unknown, maybeFunction?: unknown): this {
    const given = typeof optionsOrFunction === 'function' ? {} : optionsOrFunction ?? {}
    const fn = typeof optionsOrFunction === 'function' ? optionsOrFunction : maybeFunction
    if (typeof name !== 'string') throw new TypeError('Expected first argument to be a string')
    if (typeof fn !== 'function') throw new TypeError('Expected last argument to be a function')
    if (typeof given !== 'object') throw new TypeError('Expected second argument to be an options object')
    const definition = scalarFunction(name, given as Record<string, unknown>, fn as ScalarBody, this.#defaults)
    if (!this.#inner.isOpen) throw notOpen()
    guarded(() => { registerScalarFunction(this.#inner, definition) })
    return this
  }

  aggregate (): never { return unbuilt('aggregate', 'user-defined aggregate functions are not built') }
  table (): never { return unbuilt('table', 'virtual tables defined in JavaScript are not built') }
  backup (destination: string, options?: { attached?: string, progress?: (info: BackupInfo) => unknown }): Promise<BackupInfo> {
    return backupDatabase(this.#inner, destination, options)
  }
  serialize (): never { return unbuilt('serialize', 'serializing a database is not built') }
  loadExtension (): never { return unbuilt('loadExtension', 'a native extension cannot be loaded into WebAssembly') }
}

export interface DatabaseConstructor {
  new (filename?: string, options?: DatabaseOptions): DatabaseImpl
  (filename?: string, options?: DatabaseOptions): DatabaseImpl
  readonly prototype: DatabaseImpl
  readonly SqliteError: typeof SqliteError
}

/** `better-sqlite3` exports a function that is also a constructor: a proxy answers a plain call with `new`, and keeps `instanceof` and `extends` working. */
export const Database = new Proxy(DatabaseImpl, {
  apply: (target, _this, args: [string?, DatabaseOptions?]) => Reflect.construct(target, args) as DatabaseImpl
}) as unknown as DatabaseConstructor
export type Database = DatabaseImpl

export default Database
