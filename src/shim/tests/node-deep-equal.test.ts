// isDeepEqual against real Node's own util.isDeepStrictEqual and
// assert.deepEqual, case by case: the table is the specification.

import { deepEqual as nodeLooseAssert } from 'node:assert'
import { isDeepStrictEqual as nodeStrict } from 'node:util'
import { describe, expect, it } from 'vitest'
import { isDeepEqual } from '../node-deep-equal.js'

function nodeLoose (a: unknown, b: unknown): boolean {
  try { nodeLooseAssert(a, b); return true } catch { return false }
}

const circularA: Record<string, unknown> = { x: 1 }
circularA['self'] = circularA
const circularB: Record<string, unknown> = { x: 1 }
circularB['self'] = circularB

const CASES: Array<[string, unknown, unknown]> = [
  ['equal numbers', 1, 1],
  ['number vs string', 1, '1'],
  ['NaN', NaN, NaN],
  ['+0 vs -0', 0, -0],
  ['null vs undefined', null, undefined],
  ['equal arrays', [1, [2, 3]], [1, [2, 3]]],
  ['arrays of different length', [1, 2], [1, 2, 3]],
  ['equal objects, key order differs', { a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 }],
  ['object with an extra key', { a: 1 }, { a: 1, b: 2 }],
  ['different prototypes', Object.create(null), {}],
  ['equal dates', new Date(5), new Date(5)],
  ['different dates', new Date(5), new Date(6)],
  ['equal regexps', /a/g, /a/g],
  ['regexps with different flags', /a/g, /a/i],
  ['equal byte arrays', new Uint8Array([1, 2]), new Uint8Array([1, 2])],
  ['different byte arrays', new Uint8Array([1, 2]), new Uint8Array([1, 3])],
  ['different typed array kinds', new Uint8Array([1]), new Int8Array([1])],
  ['equal maps', new Map([[1, { a: 1 }]]), new Map([[1, { a: 1 }]])],
  ['different maps', new Map([[1, 'a']]), new Map([[1, 'b']])],
  ['equal sets of objects', new Set([{ a: 1 }]), new Set([{ a: 1 }])],
  ['different sets', new Set([1]), new Set([2])],
  ['equal errors', new Error('x'), new Error('x')],
  ['errors with different messages', new Error('x'), new Error('y')],
  ['boxed and primitive', Object(1), 1],
  ['circular structures', circularA, circularB],
  ['array vs object', [1], { 0: 1 }]
]

describe('isDeepEqual', () => {
  it.each(CASES)('strict: %s', (_label, a, b) => {
    expect(isDeepEqual(a, b, true)).toBe(nodeStrict(a, b))
  })

  it.each(CASES)('loose: %s', (_label, a, b) => {
    expect(isDeepEqual(a, b, false)).toBe(nodeLoose(a, b))
  })
})
