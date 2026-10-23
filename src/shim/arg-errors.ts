// The argument errors Node throws before it does anything: ERR_INVALID_ARG_TYPE and ERR_OUT_OF_RANGE, worded as
// Node words them, for the members of this package that validate their arguments as Node does.

import { codedError } from './node-errors.js'

/** `1234567` as `1_234_567`: Node writes a number beyond 2^32 this way in an out-of-range message. */
function withSeparators (value: number): string {
  if (Math.abs(value) <= 2 ** 32) return String(value)
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '_')
}

/** The `Received ...` tail of an ERR_INVALID_ARG_TYPE message. */
export function receivedText (value: unknown): string {
  if (value === undefined || value === null) return `Received ${String(value)}`
  if (typeof value === 'function') return `Received function ${value.name}`
  if (typeof value === 'object') return `Received an instance of ${value.constructor?.name ?? 'Object'}`
  const shown = typeof value === 'string' ? `'${value}'` : String(value)
  return `Received type ${typeof value} (${shown})`
}

/** `The "name" argument must be <expected>. Received ...`. */
export function invalidArgType (name: string, expected: string, value: unknown): TypeError & { code: string } {
  return codedError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "${name}" argument must be ${expected}. ${receivedText(value)}`)
}

/** `The "options.name" property must be <expected>. Received ...`, for one field of an options object. */
export function invalidOption (name: string, expected: string, value: unknown): TypeError & { code: string } {
  return codedError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "options.${name}" property must be ${expected}. ${receivedText(value)}`)
}

/** `The value of "name" is out of range. It must be <requirement>. Received n`. */
export function outOfRangeError (name: string, requirement: string, value: number): RangeError & { code: string } {
  return codedError(RangeError, 'ERR_OUT_OF_RANGE', `The value of "${name}" is out of range. It must be ${requirement}. Received ${withSeparators(value)}`)
}
