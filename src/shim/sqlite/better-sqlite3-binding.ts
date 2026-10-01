// Turns the arguments of a `better-sqlite3` statement call into the ones
// `StatementSync` takes: any mix of values, arrays of values and one object of
// named parameters, checked as `better-sqlite3` checks them.

const INT64_MAX = 2n ** 63n - 1n
const INT64_MIN = -(2n ** 63n)
const NUMBERED = /^\?(\d+)$/

function isPlainObject (value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === null || prototype === Object.prototype
}

/** A JavaScript value as SQLite stores it: an integer that fits 32 bits is an INTEGER and every other number a REAL, as `better-sqlite3` binds them. */
function storable (value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return (value | 0) === value && !Object.is(value, -0) ? BigInt(value) : value
  if (typeof value === 'bigint') {
    if (value > INT64_MAX || value < INT64_MIN) throw new RangeError('BigInt value is too large to bind')
    return value
  }
  if (typeof value === 'string' || ArrayBuffer.isView(value)) return value
  throw new TypeError('SQLite3 can only bind numbers, strings, bigints, buffers, and null')
}

/**
 * `args` as the argument list for `StatementSync`, given the statement's parameter names
 * (`statementTraits`). A value fills a bare `?` in order, and `?NNN` by its number; the
 * object fills `@name`, `:name` and `$name` by the bare name. Named parameters go to the
 * statement under their full written name, so `StatementSync` needs no bare-name lookup.
 */
export function bindingArguments (parameterNames: readonly (string | null)[], args: readonly unknown[]): unknown[] {
  const values: unknown[] = []
  let named: Record<string, unknown> | undefined
  for (const arg of args) {
    if (Array.isArray(arg)) values.push(...arg)
    else if (isPlainObject(arg)) {
      if (named !== undefined) throw new TypeError('You cannot specify named parameters in two different objects')
      named = arg
    } else values.push(arg)
  }
  let anonymous = 0
  let wanted = 0
  for (const name of parameterNames) {
    if (name === null) wanted = Math.max(wanted, ++anonymous)
    else if (NUMBERED.test(name)) wanted = Math.max(wanted, Number(NUMBERED.exec(name)?.[1]))
  }
  const hasNamed = parameterNames.some((name) => name !== null && !NUMBERED.test(name))
  if (values.length < wanted || (hasNamed && named === undefined)) throw new RangeError('Too few parameter values were provided')
  if (values.length > wanted) throw new RangeError('Too many parameter values were provided')
  const byName: Record<string, unknown> = {}
  for (const name of parameterNames) {
    if (name === null) continue
    const numbered = NUMBERED.exec(name)
    if (numbered !== null) byName[name] = storable(values[Number(numbered[1]) - 1])
    else {
      const bare = name.slice(1)
      if (named === undefined || !Object.hasOwn(named, bare)) throw new RangeError(`Missing named parameter "${bare}"`)
      byName[name] = storable(named[bare])
    }
  }
  const result = values.slice(0, anonymous).map(storable)
  if (Object.keys(byName).length > 0) result.push(byName)
  return result
}
