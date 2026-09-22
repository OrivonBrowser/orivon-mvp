// The `util` module target beyond inherits (node-util.test.ts): the `util`
// package's format/inspect/types/deprecate/callbackify, a Node-exact
// promisify, and the members the package predates.

import { format as nodeFormat } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import util, { callbackify, format, inspect, isDeepStrictEqual, promisify, TextDecoder, TextEncoder, types } from '../node-util.js'

describe('promisify', () => {
  it('resolves with the callback\'s value and rejects with its error', async () => {
    const ok = promisify((value: number, cb: (err: Error | null, result?: number) => void) => { cb(null, value * 2) })
    await expect(ok(21)).resolves.toBe(42)
    const fail = promisify((cb: (err: Error | null) => void) => { cb(new Error('boom')) })
    await expect(fail()).rejects.toThrow('boom')
  })

  it('keeps `this`', async () => {
    const target = { base: 1, add (n: number, cb: (err: null, sum: number) => void) { cb(null, this.base + n) } }
    await expect(promisify(target.add).call(target, 2)).resolves.toBe(3)
  })

  // A library marks its own promise form with the registry symbol, without
  // importing util: the package's private symbol would miss it.
  it('honours a custom form under Symbol.for(\'nodejs.util.promisify.custom\')', async () => {
    const custom = Symbol.for('nodejs.util.promisify.custom')
    expect(promisify.custom).toBe(custom)
    const fn = Object.assign(() => {}, { [custom]: async () => 'custom' })
    expect(promisify(fn)).toBe(fn[custom])
  })

  it('refuses a non-function the way Node does', () => {
    expect(() => promisify(42 as unknown as () => void)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }))
  })
})

describe('the util package\'s members', () => {
  it('format matches Node', () => {
    expect(format('%s:%d %j %%', 'a', 7, { b: 1 })).toBe(nodeFormat('%s:%d %j %%', 'a', 7, { b: 1 }))
  })

  it('inspect renders an object', () => {
    expect(inspect({ a: 1, b: [1, 2] })).toContain('a: 1')
  })

  it('types answers', () => {
    expect(types.isPromise(Promise.resolve())).toBe(true)
    expect(types.isUint8Array(new Uint8Array(1))).toBe(true)
    expect(types.isDate(new Date())).toBe(true)
  })

  it('callbackify calls back with the resolved value', async () => {
    const cb = vi.fn()
    callbackify(async (n: number) => n + 1)(1, cb)
    await vi.waitFor(() => { expect(cb).toHaveBeenCalledWith(null, 2) })
  })
})

describe('members the package predates', () => {
  it('TextEncoder and TextDecoder are the platform\'s', () => {
    expect(TextEncoder).toBe(globalThis.TextEncoder)
    expect(new TextDecoder().decode(new TextEncoder().encode('é'))).toBe('é')
  })

  it('isDeepStrictEqual compares deeply and strictly', () => {
    expect(isDeepStrictEqual({ a: [1] }, { a: [1] })).toBe(true)
    expect(isDeepStrictEqual({ a: 1 }, { a: '1' })).toBe(false)
  })
})

describe('the default export', () => {
  it('carries every member, the legacy ones included', () => {
    expect(util.promisify).toBe(promisify)
    expect(util.inherits).toBeTypeOf('function')
    expect((util as unknown as { isArray: (value: unknown) => boolean }).isArray([])).toBe(true)
  })

  it('refuses a member it lacks by name, only when called', () => {
    const { parseArgs } = util as unknown as { parseArgs: () => unknown }
    expect(() => parseArgs()).toThrow(expect.objectContaining({ name: 'OrivonShimError', api: 'util.parseArgs' }))
  })
})
