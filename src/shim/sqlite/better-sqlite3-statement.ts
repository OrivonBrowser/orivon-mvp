// `better-sqlite3`'s `Statement` over a `StatementSync`. The inner statement
// always reads integers as bigints, in arrays: this class shapes every row
// itself, so `safeIntegers`, `pluck`, `raw` and `expand` are one code path.

import type { StatementSync } from './statement.js'
import { statementTraits } from './statement.js'
import { bindingArguments } from './better-sqlite3-binding.js'
import { guarded, notOpen, translate } from './better-sqlite3-errors.js'

type Cell = null | number | bigint | string | Uint8Array
type InnerRow = Cell[]
type Mode = 'pluck' | 'raw' | 'expand'

/** What a statement needs from the database that prepared it. */
export interface StatementHost {
  readonly database: unknown
  isOpen (): boolean
  /** Reports the SQL a statement ran to the `verbose` option's callback, if there is one; `sql` is not called otherwise. */
  trace (sql: () => string): void
}

function toggleOf (toggle: unknown): boolean {
  if (toggle === undefined) return true
  if (typeof toggle !== 'boolean') throw new TypeError('Expected first argument to be a boolean')
  return toggle
}

/** A property that is always the row's own, even for a column named `__proto__`. */
function setOwn (target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

export class Statement {
  readonly source: string
  readonly database: unknown
  readonly #inner: StatementSync
  readonly #host: StatementHost
  readonly #pragma: boolean
  readonly #parameterNames: readonly (string | null)[]
  readonly #readOnly: boolean
  #columns: Array<{ name: string, table: string | null }> | undefined
  #mode: Mode | undefined
  #safeIntegers: boolean
  #bound: unknown[] | undefined

  /** `pragma` marks a `PRAGMA` statement: one that sets a value has no columns and still counts as returning data. */
  constructor (host: StatementHost, inner: StatementSync, source: string, safeIntegers: boolean, pragma: boolean) {
    inner.setReadBigInts(true)
    inner.setReturnArrays(true)
    const traits = statementTraits(inner)
    this.#host = host
    this.#inner = inner
    this.#pragma = pragma
    this.#safeIntegers = safeIntegers
    this.#parameterNames = traits.parameterNames
    this.#readOnly = traits.readOnly
    this.source = source
    this.database = host.database
  }

  get reader (): boolean {
    return this.#pragma || this.#describe().length > 0
  }

  get readonly (): boolean {
    return this.#readOnly
  }

  #describe (): Array<{ name: string, table: string | null }> {
    this.#columns ??= this.#inner.columns().map((column) => ({ name: column.name as string, table: column.table ?? null }))
    return this.#columns
  }

  #open (): void {
    if (!this.#host.isOpen()) throw notOpen()
  }

  #arguments (args: readonly unknown[]): unknown[] {
    if (this.#bound !== undefined) {
      if (args.length > 0) throw new TypeError('This statement already has bound parameters')
      return this.#bound
    }
    return bindingArguments(this.#parameterNames, args)
  }

  #returnsData (): void {
    if (!this.reader) throw new TypeError('This statement does not return data. Use run() instead')
  }

  #cell (cell: Cell): Cell {
    return typeof cell === 'bigint' && !this.#safeIntegers ? Number(cell) : cell
  }

  #shape (row: InnerRow): unknown {
    if (this.#mode === 'pluck') return this.#cell(row[0] as Cell)
    const cells = row.map((cell) => this.#cell(cell))
    if (this.#mode === 'raw') return cells
    const names = this.#describe()
    const shaped: Record<string, unknown> = {}
    cells.forEach((cell, i) => {
      const column = names[i] as { name: string, table: string | null }
      let target = shaped
      if (this.#mode === 'expand') {
        const table = column.table ?? '$'
        if (!Object.hasOwn(shaped, table)) setOwn(shaped, table, {})
        target = shaped[table] as Record<string, unknown>
      }
      setOwn(target, column.name, cell)
    })
    return shaped
  }

  /** Runs `execute`, then reports the SQL it ran with its parameters filled in, whether or not it threw. */
  #traced<T> (execute: () => T): T {
    try {
      return guarded(execute)
    } finally {
      this.#host.trace(() => this.#inner.expandedSQL)
    }
  }

  run (...args: unknown[]): { changes: number, lastInsertRowid: number | bigint } {
    this.#open()
    const bound = this.#arguments(args)
    const info = this.#traced(() => this.#inner.run(...(bound as never[]))) as { changes: bigint, lastInsertRowid: bigint }
    return { changes: Number(info.changes), lastInsertRowid: this.#safeIntegers ? info.lastInsertRowid : Number(info.lastInsertRowid) }
  }

  get (...args: unknown[]): unknown {
    this.#open()
    this.#returnsData()
    const bound = this.#arguments(args)
    const row = this.#traced(() => this.#inner.get(...(bound as never[]))) as InnerRow | undefined
    return row === undefined ? undefined : this.#shape(row)
  }

  all (...args: unknown[]): unknown[] {
    this.#open()
    this.#returnsData()
    const bound = this.#arguments(args)
    const rows = this.#traced(() => this.#inner.all(...(bound as never[]))) as InnerRow[]
    return rows.map((row) => this.#shape(row))
  }

  iterate (...args: unknown[]): IterableIterator<unknown> {
    this.#open()
    this.#returnsData()
    const bound = this.#arguments(args)
    const rows = this.#traced(() => this.#inner.iterate(...(bound as never[]))) as IterableIterator<InnerRow>
    const shape = (row: InnerRow): unknown => this.#shape(row)
    return (function * () {
      try {
        for (const row of rows) yield shape(row)
      } catch (error) {
        throw translate(error)
      }
    })()
  }

  #setMode (mode: Mode, toggle: unknown): this {
    const enabled = toggleOf(toggle)
    if (!this.reader) throw new TypeError(`The ${mode}() method is only for statements that return data`)
    if (enabled) this.#mode = mode
    else if (this.#mode === mode) this.#mode = undefined
    return this
  }

  pluck (toggle?: boolean): this { return this.#setMode('pluck', toggle) }
  raw (toggle?: boolean): this { return this.#setMode('raw', toggle) }
  expand (toggle?: boolean): this { return this.#setMode('expand', toggle) }

  safeIntegers (toggle?: boolean): this {
    this.#safeIntegers = toggleOf(toggle)
    return this
  }

  bind (...args: unknown[]): this {
    if (this.#bound !== undefined) throw new TypeError('The bind() method can only be invoked once per statement object')
    this.#open()
    this.#bound = bindingArguments(this.#parameterNames, args)
    return this
  }

  columns (): Array<{ name: string, column: string | null, table: string | null, database: string | null, type: string | null }> {
    this.#open()
    if (!this.reader) throw new TypeError('The columns() method is only for statements that return data')
    return this.#inner.columns().map((column) => ({
      name: column.name as string, column: column.column ?? null, table: column.table ?? null, database: column.database ?? null, type: column.type ?? null
    }))
  }
}
