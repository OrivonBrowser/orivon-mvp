// `crypto.randomInt([min, ]max[, callback])`: Node's argument checks and error codes over the platform's
// `getRandomValues`.

import { invalidArgType, outOfRangeError } from '../arg-errors.js'

type RandomIntCallback = (error: Error | undefined, value: number) => void

/** Node's bound on `max - min`: 2^48 - 1, the span six random bytes can cover. */
const RAND_MAX = 0xFFFF_FFFF_FFFF
const RANGE_OF_SIX_BYTES = RAND_MAX + 1

/**
 * A uniform integer below `range` by rejection sampling over six random bytes: a draw in the uneven tail
 * of the 2^48 values is thrown away and redrawn, so no result is likelier than another (a plain remainder would favour the low ones).
 */
function uniformBelow (range: number): number {
  const accepted = RANGE_OF_SIX_BYTES - (RANGE_OF_SIX_BYTES % range)
  const bytes = new Uint8Array(6)
  for (;;) {
    globalThis.crypto.getRandomValues(bytes)
    let drawn = 0
    for (const byte of bytes) drawn = drawn * 256 + byte
    if (drawn < accepted) return drawn % range
  }
}

export function randomInt (max: number): number
export function randomInt (min: number, max: number): number
export function randomInt (max: number, callback: RandomIntCallback): void
export function randomInt (min: number, max: number, callback: RandomIntCallback): void
export function randomInt (first: number, second?: number | RandomIntCallback, third?: RandomIntCallback): number | undefined {
  const minGiven = second !== undefined && typeof second !== 'function'
  const min = minGiven ? first : 0
  const max = minGiven ? second : first
  const callback = minGiven ? third : second
  if (callback !== undefined && typeof callback !== 'function') {
    throw invalidArgType('callback', 'of type function', callback)
  }
  if (!Number.isSafeInteger(min)) throw invalidArgType('min', 'a safe integer', min)
  if (!Number.isSafeInteger(max)) throw invalidArgType('max', 'a safe integer', max)
  if (max <= min) throw outOfRangeError('max', `greater than the value of "min" (${String(min)})`, max)
  const range = max - min
  if (!(range <= RAND_MAX)) throw outOfRangeError(minGiven ? 'max - min' : 'max', `<= ${String(RAND_MAX)}`, range)
  const value = min + uniformBelow(range)
  if (callback === undefined) return value
  queueMicrotask(() => { callback(undefined, value) })
  return undefined
}
