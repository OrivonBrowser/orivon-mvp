// assert, timers and timers/promises: hand-written module targets, checked
// against Node's own behaviour on the same calls.

import { describe, expect, it, vi } from 'vitest'
import assert, { AssertionError, deepEqual, deepStrictEqual, equal, ok, rejects, strictEqual, throws } from '../node-assert.js'
import timers from '../node-timers.js'
import timersPromises from '../node-timers-promises.js'

describe('assert', () => {
  it('is callable as ok, and passes a truthy value', () => {
    expect(() => assert(1)).not.toThrow()
    expect(() => ok(true)).not.toThrow()
  })

  it('throws an AssertionError with Node\'s code and fields', () => {
    const error = (() => { try { strictEqual(1, 2); return undefined } catch (caught) { return caught } })()
    expect(error).toBeInstanceOf(AssertionError)
    expect(error).toMatchObject({ code: 'ERR_ASSERTION', actual: 1, expected: 2, operator: 'strictEqual', generatedMessage: true })
  })

  it('uses a given message, or throws a given Error as is', () => {
    expect(() => ok(false, 'custom')).toThrow('custom')
    const own = new RangeError('own')
    expect(() => ok(false, own)).toThrow(own)
  })

  it('equal is ==, strictEqual is Object.is', () => {
    expect(() => equal(1, '1')).not.toThrow()
    expect(() => strictEqual(1, '1')).toThrow(AssertionError)
    expect(() => strictEqual(NaN, NaN)).not.toThrow()
  })

  it('deepEqual is loose, deepStrictEqual is strict', () => {
    expect(() => deepEqual({ a: 1 }, { a: '1' })).not.toThrow()
    expect(() => deepStrictEqual({ a: 1 }, { a: '1' })).toThrow(AssertionError)
    expect(() => deepStrictEqual({ a: [1] }, { a: [1] })).not.toThrow()
  })

  it('throws checks the thrown error against a class, a RegExp, an object or a function', () => {
    const fail = (): never => { throw new TypeError('bad thing') }
    expect(() => throws(fail)).not.toThrow()
    expect(() => throws(fail, TypeError)).not.toThrow()
    expect(() => throws(fail, /bad/)).not.toThrow()
    expect(() => throws(fail, { name: 'TypeError', message: 'bad thing' })).not.toThrow()
    expect(() => throws(fail, RangeError)).toThrow(AssertionError)
    expect(() => throws(fail, /nomatch/)).toThrow(AssertionError)
    expect(() => throws(() => {})).toThrow(AssertionError)
  })

  it('rejects awaits a rejection and checks it the same way', async () => {
    await expect(rejects(Promise.reject(new TypeError('x')), TypeError)).resolves.toBeUndefined()
    await expect(rejects(async () => {})).rejects.toBeInstanceOf(AssertionError)
  })

  it('carries strict, whose equal and deepEqual are the strict forms', () => {
    expect(() => assert.strict.equal(1, '1' as unknown as number)).toThrow(AssertionError)
    expect(() => assert.strict.deepEqual({ a: 1 }, { a: '1' })).toThrow(AssertionError)
  })
})

describe('timers', () => {
  it('re-exports the page\'s own timer functions', async () => {
    const callback = vi.fn()
    timers.setTimeout(callback, 0)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(callback).toHaveBeenCalled()
    expect(typeof timers.clearInterval).toBe('function')
  })
})

describe('timers/promises', () => {
  it('setTimeout resolves with the given value after the delay', async () => {
    await expect(timersPromises.setTimeout(1, 'done')).resolves.toBe('done')
  })

  it('setImmediate resolves with the given value', async () => {
    await expect(timersPromises.setImmediate('now')).resolves.toBe('now')
  })

  it('an aborted signal rejects with an AbortError and clears the timer', async () => {
    const controller = new AbortController()
    const pending = timersPromises.setTimeout(10_000, 'never', { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' })
    await expect(timersPromises.setTimeout(1, 'x', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
