import { describe, expect, it } from 'vitest'
import { isJsonCompatibleResult, webContextResultRejection } from '../web-context-result.js'

// WebContext.evaluate's own strict grammar (contracts/handles.ts): null,
// boolean, finite number, string, and arrays or plain objects of those --
// nothing else. Electron's executeJavaScript does NOT hand back JSON text;
// it hands back real, live V8 values reconstructed by structured clone
// (measured against Electron 44, see ../../capabilities/web.ts's own header
// pointer to this file). A Date, Map, Set, RegExp, Error or TypedArray
// completion value arrives here as a REAL instance of that class, not a
// string or a plain object -- so every non-primitive case below uses the
// actual constructor, not a JSON-ish stand-in for one.

describe('webContextResultRejection -- accepted values', () => {
  it.each([
    ['null', null],
    ['true', true],
    ['false', false],
    ['zero', 0],
    ['a negative float', -3.5],
    ['an empty string', ''],
    ['a string', 'hello'],
    ['an empty array', []],
    ['an empty object', {}],
    ['a flat array of primitives', [1, 'a', true, null, false]],
    ['a flat object of primitives', { a: 1, b: 'x', c: true, d: null }],
    ['nested arrays and objects', { a: [1, { b: [2, 3] }], c: null }],
    ['a null-prototype plain object', Object.assign(Object.create(null), { a: 1 })]
  ])('%s', (_label, value) => {
    expect(webContextResultRejection(value)).toBeNull()
    expect(isJsonCompatibleResult(value)).toBe(true)
  })

  it('the same object referenced twice in a DAG is not mistaken for a cycle', () => {
    const shared = { x: 1 }
    expect(webContextResultRejection({ a: shared, b: shared })).toBeNull()
    expect(webContextResultRejection([shared, shared])).toBeNull()
  })
})

describe('webContextResultRejection -- non-finite numbers', () => {
  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity]
  ])('rejects %s, which JSON.stringify would silently turn into null', (_label, value) => {
    expect(webContextResultRejection(value)).toBe('non-finite-number')
  })

  it('rejects a non-finite number nested inside an array or object', () => {
    expect(webContextResultRejection([1, NaN])).toBe('non-finite-number')
    expect(webContextResultRejection({ a: Infinity })).toBe('non-finite-number')
  })
})

describe('webContextResultRejection -- values a structured clone can carry but JSON cannot', () => {
  it('rejects a bigint', () => {
    expect(webContextResultRejection(1n)).toBe('bigint')
  })

  it('rejects a symbol', () => {
    expect(webContextResultRejection(Symbol('x'))).toBe('symbol')
  })

  it('rejects a function', () => {
    expect(webContextResultRejection(() => {})).toBe('function')
  })

  it('rejects undefined nested in an array', () => {
    expect(webContextResultRejection([undefined, 1])).toBe('undefined')
  })

  it('rejects undefined nested in an object -- structured clone keeps the key, unlike JSON.stringify', () => {
    expect(webContextResultRejection({ a: undefined, b: 1 })).toBe('undefined')
  })

  it('rejects bare top-level undefined too -- the null substitution is the caller\'s job, not this predicate\'s', () => {
    expect(webContextResultRejection(undefined)).toBe('undefined')
  })
})

describe('webContextResultRejection -- non-plain objects Electron\'s structured clone reconstructs as real instances', () => {
  it.each([
    ['a Date', new Date(0)],
    ['a Map', new Map([['a', 1]])],
    ['a Set', new Set([1, 2, 3])],
    ['a RegExp', /abc/g],
    ['an Error', new Error('boom')],
    ['a Uint8Array', new Uint8Array([1, 2, 3])]
  ])('rejects %s', (_label, value) => {
    expect(webContextResultRejection(value)).toBe('non-plain-object')
  })

  it('rejects a class instance', () => {
    class Foo { x = 1 }
    expect(webContextResultRejection(new Foo())).toBe('non-plain-object')
  })

  it('rejects one nested inside an otherwise-plain object', () => {
    expect(webContextResultRejection({ a: new Date(0) })).toBe('non-plain-object')
  })
})

describe('webContextResultRejection -- cycles and depth', () => {
  it('rejects a self-referencing object', () => {
    const o: Record<string, unknown> = {}
    o.self = o
    expect(webContextResultRejection(o)).toBe('cycle')
  })

  it('rejects a self-referencing array', () => {
    const a: unknown[] = []
    a.push(a)
    expect(webContextResultRejection(a)).toBe('cycle')
  })

  it('rejects a longer cycle (a -> b -> a)', () => {
    const a: Record<string, unknown> = {}
    const b: Record<string, unknown> = { a }
    a.b = b
    expect(webContextResultRejection(a)).toBe('cycle')
  })

  it('accepts a structure right at the depth bound', () => {
    let value: unknown = 1
    for (let i = 0; i < 60; i += 1) value = { next: value }
    expect(webContextResultRejection(value)).toBeNull()
  })

  it('rejects a structure past the depth bound rather than overflowing the stack', () => {
    let value: unknown = 1
    for (let i = 0; i < 10_000; i += 1) value = { next: value }
    expect(webContextResultRejection(value)).toBe('too-deep')
  })
})
