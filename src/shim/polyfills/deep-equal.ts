// Node's deep equality, in both modes: strict (util.isDeepStrictEqual,
// assert.deepStrictEqual) and loose (assert.deepEqual). One implementation
// for util and assert. Checked case by case against real Node in
// tests/node-deep-equal.test.ts rather than against a reading of its source.

type Memo = Map<object, Set<object>>

function tag (value: object): string { return Object.prototype.toString.call(value) }

function isObject (value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function primitivesEqual (a: unknown, b: unknown, strict: boolean): boolean {
  if (strict) return Object.is(a, b)
  // Loose mode is Node's `==`, with NaN equal to itself.
  return a == b || (Number.isNaN(a) && Number.isNaN(b))
}

function bytesOf (view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function ownKeys (value: object, strict: boolean): PropertyKey[] {
  const keys: PropertyKey[] = Object.keys(value)
  if (!strict) return keys
  return keys.concat(Object.getOwnPropertySymbols(value).filter((symbol) => Object.prototype.propertyIsEnumerable.call(value, symbol)))
}

/** Values that must match before own keys are compared at all: the parts of a Date, RegExp, Error, boxed primitive or byte view no key holds. */
function internalsEqual (a: object, b: object, strict: boolean): boolean {
  if (a instanceof Date) return b instanceof Date && Object.is(a.getTime(), b.getTime())
  if (a instanceof RegExp) return b instanceof RegExp && a.source === b.source && a.flags === b.flags
  if (a instanceof Error) return b instanceof Error && a.message === b.message && a.name === b.name
  if (ArrayBuffer.isView(a)) {
    if (!ArrayBuffer.isView(b)) return false
    const left = bytesOf(a)
    const right = bytesOf(b)
    return left.length === right.length && left.every((byte, index) => byte === right[index])
  }
  const boxed = [Number, String, Boolean, BigInt, Symbol].find((kind) => a instanceof kind)
  if (boxed !== undefined) return b instanceof boxed && primitivesEqual(a.valueOf(), b.valueOf(), strict)
  return true
}

/** Finds, and consumes, one entry of `pool` deep-equal to `wanted`. */
function takeMatch (pool: unknown[], wanted: unknown, strict: boolean, memo: Memo): boolean {
  const index = pool.findIndex((candidate) => deepEqual(candidate, wanted, strict, memo))
  if (index === -1) return false
  pool.splice(index, 1)
  return true
}

function setsEqual (a: Set<unknown>, b: Set<unknown>, strict: boolean, memo: Memo): boolean {
  const pool = [...b].filter((value) => !(!isObject(value) && a.has(value)))
  for (const value of a) {
    if (!isObject(value) && b.has(value)) continue
    if (!takeMatch(pool, value, strict, memo)) return false
  }
  return true
}

function mapsEqual (a: Map<unknown, unknown>, b: Map<unknown, unknown>, strict: boolean, memo: Memo): boolean {
  const pool = [...b].filter(([key]) => !(!isObject(key) && a.has(key)))
  for (const [key, value] of a) {
    if (!isObject(key) && b.has(key)) {
      if (!deepEqual(value, b.get(key), strict, memo)) return false
      continue
    }
    if (!takeMatch(pool, [key, value], strict, memo)) return false
  }
  return true
}

function deepEqual (a: unknown, b: unknown, strict: boolean, memo: Memo): boolean {
  if (!isObject(a) || !isObject(b)) return !isObject(a) && !isObject(b) && primitivesEqual(a, b, strict)
  if (a === b) return true
  if (tag(a) !== tag(b) || Array.isArray(a) !== Array.isArray(b)) return false
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false
  if (!internalsEqual(a, b, strict)) return false

  // A pair already being compared higher up is assumed equal, so a cycle ends.
  const seen = memo.get(a)
  if (seen?.has(b) === true) return true
  if (seen === undefined) memo.set(a, new Set([b])); else seen.add(b)

  if (a instanceof Set) return b instanceof Set && a.size === b.size && setsEqual(a, b, strict, memo)
  if (a instanceof Map) return b instanceof Map && a.size === b.size && mapsEqual(a, b, strict, memo)
  if (ArrayBuffer.isView(a)) return true

  const keys = ownKeys(a, strict)
  if (keys.length !== ownKeys(b, strict).length) return false
  return keys.every((key) => Object.prototype.propertyIsEnumerable.call(b, key) &&
    deepEqual((a as Record<PropertyKey, unknown>)[key], (b as Record<PropertyKey, unknown>)[key], strict, memo))
}

export function isDeepEqual (a: unknown, b: unknown, strict: boolean): boolean {
  return deepEqual(a, b, strict, new Map())
}
