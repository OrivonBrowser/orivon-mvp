// Scalar SQL functions written in JavaScript. `DatabaseSync#function` and the
// `better-sqlite3` adapter's `Database#function` both register through here,
// each with its own rules for the values that cross (README.md, Design notes).

import { outOfRange, sqliteError } from './errors.js'
import type { DatabaseState } from './statement.js'

export type IntegerArguments = 'bigint' | 'lossy' | 'checked'
export type FunctionValue = null | number | bigint | string | Uint8Array

export interface ScalarFunction {
  readonly name: string
  /** The count of arguments the function takes, or -1 for any number. */
  readonly argc: number
  readonly deterministic: boolean
  readonly directOnly: boolean
  /** Asked at each call: an INTEGER argument arrives as a bigint, as a number that loses precision beyond 2^53, or as a number and a `RangeError` beyond it. */
  readonly integers: () => IntegerArguments
  /** Whose rules a result follows: a value SQLite cannot store fails the statement with SQLite's own error in Node, and is a `TypeError` in `better-sqlite3`. */
  readonly rules: 'node' | 'better-sqlite3'
  readonly fn: (...args: FunctionValue[]) => unknown
}

const SQLITE_INTEGER = 1
const SQLITE_FLOAT = 2
const SQLITE_TEXT = 3
const SQLITE_BLOB = 4
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const INT64_MAX = 2n ** 63n - 1n
const INT64_MIN = -(2n ** 63n)
const POINTER_BYTES = 4
const encoder = new TextEncoder()
const decoder = new TextDecoder()

type Sqlite3 = DatabaseState['sqlite3']

function readArgument (sqlite3: Sqlite3, value: number, integers: IntegerArguments): FunctionValue {
  const { wasm } = sqlite3
  const { exports } = wasm
  switch (exports.sqlite3_value_type(value)) {
    case SQLITE_INTEGER: {
      const integer = exports.sqlite3_value_int64(value)
      if (integers === 'bigint') return integer
      if (integers === 'checked' && (integer > MAX_SAFE || integer < -MAX_SAFE)) throw outOfRange(`Value is too large to be represented as a JavaScript number: ${String(integer)}`)
      return Number(integer)
    }
    case SQLITE_FLOAT: return exports.sqlite3_value_double(value)
    case SQLITE_TEXT: {
      const pointer = exports.sqlite3_value_text(value)
      return decoder.decode(wasm.heap8u().subarray(pointer, pointer + exports.sqlite3_value_bytes(value)))
    }
    case SQLITE_BLOB: {
      const pointer = exports.sqlite3_value_blob(value)
      const length = exports.sqlite3_value_bytes(value)
      return length === 0 ? new Uint8Array(0) : wasm.heap8u().slice(pointer, pointer + length)
    }
    default: return null
  }
}

/** Gives `bytes` to SQLite as a text or blob result; SQLite frees the copy. */
function resultBytes (sqlite3: Sqlite3, context: number, bytes: Uint8Array, text: boolean): void {
  const { wasm, capi } = sqlite3
  if (bytes.length === 0 && !text) {
    wasm.exports.sqlite3_result_zeroblob(context, 0)
    return
  }
  const copy = wasm.alloc(Math.max(bytes.length, 1))
  wasm.heap8u().set(bytes, copy)
  const give = text ? wasm.exports.sqlite3_result_text : wasm.exports.sqlite3_result_blob
  give(context, copy, bytes.length, capi.SQLITE_WASM_DEALLOC)
}

function resultError (sqlite3: Sqlite3, context: number, message: string): void {
  const { wasm } = sqlite3
  const bytes = encoder.encode(message)
  const copy = wasm.alloc(bytes.length + 1)
  wasm.heap8u().set(bytes, copy)
  wasm.heap8u()[copy + bytes.length] = 0
  wasm.exports.sqlite3_result_error(context, copy, bytes.length)
  wasm.dealloc(copy)
}

function writeResult (sqlite3: Sqlite3, context: number, value: unknown, rules: ScalarFunction['rules']): void {
  const { exports } = sqlite3.wasm
  if (value === null || value === undefined) exports.sqlite3_result_null(context)
  else if (typeof value === 'number') exports.sqlite3_result_double(context, value)
  else if (typeof value === 'bigint' && value <= INT64_MAX && value >= INT64_MIN) exports.sqlite3_result_int64(context, value)
  else if (typeof value === 'string') resultBytes(sqlite3, context, encoder.encode(value), true)
  else if (ArrayBuffer.isView(value)) resultBytes(sqlite3, context, new Uint8Array(value.buffer, value.byteOffset, value.byteLength), false)
  else if (rules === 'better-sqlite3') throw new TypeError('User-defined functions can only return numbers, strings, bigints, buffers, and null')
  else resultError(sqlite3, context, typeof value === 'bigint' ? 'BigInt value is too large for SQLite' : 'Returned JavaScript value cannot be converted to a SQLite value')
}

/**
 * Registers `definition` on the connection, replacing a function of the same name and argument count.
 * An exception the function throws fails the statement that called it, and the call that ran the
 * statement throws that exception itself (`failureOf`, statement.ts), as Node and `better-sqlite3` do.
 */
export function defineScalarFunction (database: DatabaseState, definition: ScalarFunction): void {
  const { sqlite3 } = database
  const { capi, wasm } = sqlite3
  const call = (context: number, argc: number, argv: number): void => {
    try {
      const args: FunctionValue[] = []
      for (let i = 0; i < argc; i++) args.push(readArgument(sqlite3, wasm.peekPtr(argv + i * POINTER_BYTES), definition.integers()))
      database.running++
      let result: unknown
      try {
        result = definition.fn(...args)
      } finally {
        database.running--
      }
      writeResult(sqlite3, context, result, definition.rules)
    } catch (error) {
      database.thrown = { error }
      wasm.exports.sqlite3_result_error_code(context, capi.SQLITE_ERROR)
    }
  }
  // The package's own wrapper hands the callback converted values; this one needs SQLite's, so it is given raw pointers.
  const callPointer = wasm.installFunction('v(pip)', call)
  // SQLite calls this when the function is replaced, when the connection closes, and when registering fails.
  const destroyPointer = wasm.installFunction('v(p)', () => {
    wasm.uninstallFunction(callPointer)
    wasm.uninstallFunction(destroyPointer)
  })
  const flags = capi.SQLITE_UTF8 | (definition.deterministic ? capi.SQLITE_DETERMINISTIC : 0) | (definition.directOnly ? capi.SQLITE_DIRECTONLY : 0)
  const scope = wasm.scopedAllocPush()
  try {
    const [name] = wasm.scopedAllocCString(definition.name, true)
    if (wasm.exports.sqlite3_create_function_v2(database.pointer, name, definition.argc, flags, 0, callPointer, 0, 0, destroyPointer) !== 0) {
      throw sqliteError(sqlite3, database.pointer)
    }
  } finally {
    wasm.scopedAllocPop(scope)
  }
}
