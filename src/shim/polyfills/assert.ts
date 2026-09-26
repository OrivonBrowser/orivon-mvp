// `assert` module target (module-map.ts), hand-written: the assertions test
// helpers and defensive library code call, with Node's AssertionError shape
// (code ERR_ASSERTION, actual/expected/operator). Deep equality is
// polyfills/deep-equal.ts's, shared with util.isDeepStrictEqual.

import { isDeepEqual } from './deep-equal.js'
import { nodeModule } from './module-proxy.js'
import { inspect } from './util.js'

interface AssertionErrorOptions { message?: string | undefined, actual?: unknown, expected?: unknown, operator?: string }

export class AssertionError extends Error {
  readonly code = 'ERR_ASSERTION'
  readonly actual: unknown
  readonly expected: unknown
  readonly operator: string | undefined
  readonly generatedMessage: boolean

  constructor (options: AssertionErrorOptions) {
    super(options.message ?? `${inspect(options.actual)} ${options.operator ?? '=='} ${inspect(options.expected)}`)
    this.name = 'AssertionError'
    this.actual = options.actual
    this.expected = options.expected
    this.operator = options.operator
    this.generatedMessage = options.message === undefined
  }
}

type Message = string | Error | undefined

/** A caller's own Error is thrown as is; a string replaces the generated message, as in Node. */
function fail (message: Message, generated: string, fields: Omit<AssertionErrorOptions, 'message'>): never {
  if (message instanceof Error) throw message
  const error = new AssertionError({ ...fields, message: message ?? generated })
  if (message === undefined) Object.assign(error, { generatedMessage: true })
  throw error
}

export function ok (value: unknown, message?: Message): asserts value {
  if (!value) fail(message, 'The expression evaluated to a falsy value', { actual: value, expected: true, operator: '==' })
}

function looseEqual (a: unknown, b: unknown): boolean {
  // Node's `==`, with NaN equal to itself.
  return a == b || (Number.isNaN(a) && Number.isNaN(b))
}

function compare (pass: boolean, operator: string, text: string, actual: unknown, expected: unknown, message: Message): void {
  if (!pass) fail(message, `${text}:\n\n${inspect(actual)} ${operator} ${inspect(expected)}\n`, { actual, expected, operator })
}

export function equal (actual: unknown, expected: unknown, message?: Message): void { compare(looseEqual(actual, expected), '==', 'Expected values to be loosely equal', actual, expected, message) }
export function notEqual (actual: unknown, expected: unknown, message?: Message): void { compare(!looseEqual(actual, expected), '!=', 'Expected values to be loosely unequal', actual, expected, message) }
export function strictEqual (actual: unknown, expected: unknown, message?: Message): void { compare(Object.is(actual, expected), 'strictEqual', 'Expected values to be strictly equal', actual, expected, message) }
export function notStrictEqual (actual: unknown, expected: unknown, message?: Message): void { compare(!Object.is(actual, expected), 'notStrictEqual', 'Expected values to be strictly unequal', actual, expected, message) }
export function deepEqual (actual: unknown, expected: unknown, message?: Message): void { compare(isDeepEqual(actual, expected, false), 'deepEqual', 'Expected values to be loosely deep-equal', actual, expected, message) }
export function notDeepEqual (actual: unknown, expected: unknown, message?: Message): void { compare(!isDeepEqual(actual, expected, false), 'notDeepEqual', 'Expected values not to be loosely deep-equal', actual, expected, message) }
export function deepStrictEqual (actual: unknown, expected: unknown, message?: Message): void { compare(isDeepEqual(actual, expected, true), 'deepStrictEqual', 'Expected values to be strictly deep-equal', actual, expected, message) }
export function notDeepStrictEqual (actual: unknown, expected: unknown, message?: Message): void { compare(!isDeepEqual(actual, expected, true), 'notDeepStrictEqual', 'Expected values not to be strictly deep-equal', actual, expected, message) }

type Expected = RegExp | Function | Record<string, unknown>

/** Node's check of a thrown value against throws'/rejects' `expected`: an Error class, a RegExp, a validation function, or an object of properties. */
function checkThrown (actual: unknown, expected: Expected | undefined, operator: string, message: Message): void {
  if (expected === undefined) return
  const mismatch = (text: string): never => fail(message, text, { actual, expected, operator })
  if (expected instanceof RegExp) {
    if (!expected.test(String(actual))) mismatch(`The input did not match the regular expression ${String(expected)}. Input:\n\n${inspect(String(actual))}\n`)
    return
  }
  if (typeof expected === 'function') {
    if (expected.prototype !== undefined && actual instanceof expected) return
    if (expected === Error || expected.prototype instanceof Error) mismatch(`The error is expected to be an instance of "${String(expected.name)}"`)
    if (Reflect.apply(expected, {}, [actual]) !== true) mismatch(`The ${String(expected.name) || 'validation function'} is expected to return "true"`)
    return
  }
  for (const [key, value] of Object.entries(expected)) {
    const got = (actual as Record<string, unknown> | null)?.[key]
    const pass = value instanceof RegExp && typeof got === 'string' ? value.test(got) : isDeepEqual(got, value, true)
    if (!pass) mismatch(`Expected values to be strictly deep-equal on "${key}"`)
  }
}

function splitExpected (expected: Expected | Message, message: Message): [Expected | undefined, Message] {
  return typeof expected === 'string' ? [undefined, expected] : [expected as Expected | undefined, message]
}

export function throws (fn: () => unknown, expected?: Expected | string, message?: Message): void {
  const [check, text] = splitExpected(expected, message)
  try {
    fn()
  } catch (actual) {
    checkThrown(actual, check, 'throws', text)
    return
  }
  fail(text, 'Missing expected exception.', { operator: 'throws' })
}

export function doesNotThrow (fn: () => unknown, message?: Message): void {
  try {
    fn()
  } catch (actual) {
    fail(message, `Got unwanted exception.\nActual message: "${String((actual as Error | null)?.message ?? actual)}"`, { actual, operator: 'doesNotThrow' })
  }
}

export async function rejects (promiseOrFn: Promise<unknown> | (() => Promise<unknown>), expected?: Expected | string, message?: Message): Promise<void> {
  const [check, text] = splitExpected(expected, message)
  try {
    await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn)
  } catch (actual) {
    checkThrown(actual, check, 'rejects', text)
    return
  }
  fail(text, 'Missing expected rejection.', { operator: 'rejects' })
}

export async function doesNotReject (promiseOrFn: Promise<unknown> | (() => Promise<unknown>), message?: Message): Promise<void> {
  try {
    await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn)
  } catch (actual) {
    fail(message, 'Got unwanted rejection.', { actual, operator: 'doesNotReject' })
  }
}

export function match (actual: string, expected: RegExp, message?: Message): void {
  compare(expected.test(actual), 'match', 'The input did not match the regular expression', actual, expected, message)
}

export function failAssertion (message: Message = 'Failed'): never { return fail(message, 'Failed', { operator: 'fail' }) }

const members = {
  AssertionError, ok, equal, notEqual, strictEqual, notStrictEqual, deepEqual, notDeepEqual, deepStrictEqual,
  notDeepStrictEqual, throws, doesNotThrow, rejects, doesNotReject, match, fail: failAssertion
}

/** Node's assert.strict: the same module with equal/deepEqual and their negations meaning the strict forms. */
const strict = Object.assign((value: unknown, message?: Message) => { ok(value, message) }, members, {
  equal: strictEqual, notEqual: notStrictEqual, deepEqual: deepStrictEqual, notDeepEqual: notDeepStrictEqual
})

const assert = Object.assign((value: unknown, message?: Message) => { ok(value, message) }, members, { strict })
Object.assign(strict, { strict })

export default nodeModule('assert', assert)
export { strict }
