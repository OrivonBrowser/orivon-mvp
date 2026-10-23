// `crypto.randomInt` (polyfills/random-int.ts): Node's ranges, forms, argument checks and error codes, and a draw
// that is uniform because it is rejection-sampled from `getRandomValues`.

import { randomInt as nodeRandomInt } from 'node:crypto'
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import crypto, { randomInt } from '../crypto.js'

afterEach(() => { vi.restoreAllMocks() })

/** Makes `getRandomValues` hand out these 48-bit draws in order, big-endian, then fall through to the real one. */
function feedDraws (...draws: number[]): MockInstance {
  const real = globalThis.crypto.getRandomValues.bind(globalThis.crypto) as (array: ArrayBufferView) => ArrayBufferView
  const spy = vi.spyOn(globalThis.crypto, 'getRandomValues')
  spy.mockImplementation(((array: Uint8Array) => {
    const next = draws.shift()
    if (next === undefined) return real(array)
    for (let index = 5, rest = next; index >= 0; index--, rest = Math.floor(rest / 256)) array[index] = rest % 256
    return array
  }) as never)
  return spy
}

function thrown (run: () => unknown): { code?: string, name: string, message: string } {
  try {
    run()
  } catch (error) {
    return error as { code?: string, name: string, message: string }
  }
  throw new Error('did not throw')
}

describe('crypto.randomInt', () => {
  it('is the same function by name and by default export, and no longer a refusal', () => {
    expect(crypto.randomInt).toBe(randomInt)
    expect(() => randomInt(5)).not.toThrow()
  })

  it('draws from [0, max) with one argument and [min, max) with two', () => {
    for (let round = 0; round < 200; round++) {
      expect(randomInt(3)).toBeGreaterThanOrEqual(0)
      expect(randomInt(3)).toBeLessThan(3)
      const value = randomInt(-5, 5)
      expect(value).toBeGreaterThanOrEqual(-5)
      expect(value).toBeLessThan(5)
    }
    expect(randomInt(7, 8)).toBe(7)
    expect(randomInt(1)).toBe(0)
  })

  it('reaches every value of a small range, the two ends included', () => {
    const seen = new Set<number>()
    for (let round = 0; round < 500; round++) seen.add(randomInt(-2, 3))
    expect([...seen].sort((a, b) => a - b)).toEqual([-2, -1, 0, 1, 2])
  })

  it('handles a range as wide as Node allows, 2^48 - 1, and a negative window past 2^32', () => {
    const widest = randomInt(0, 2 ** 48 - 1)
    expect(Number.isSafeInteger(widest)).toBe(true)
    expect(widest).toBeLessThan(2 ** 48 - 1)
    const low = randomInt(-(2 ** 40), -(2 ** 40) + 10)
    expect(low).toBeGreaterThanOrEqual(-(2 ** 40))
    expect(low).toBeLessThan(-(2 ** 40) + 10)
  })

  it('draws from getRandomValues and from nothing else', () => {
    const spy = feedDraws(4)
    expect(randomInt(10)).toBe(4)
    expect(spy).toHaveBeenCalledOnce()
  })

  it('throws away a draw from the uneven tail and draws again, so the low values are no likelier', () => {
    const tail = 2 ** 48 - 1
    const spy = feedDraws(tail, tail - 1, 7)
    expect(randomInt(10)).toBe(7)
    expect(spy).toHaveBeenCalledTimes(3)
    expect(2 ** 48 % 10).toBe(6)
  })

  it('keeps a draw just below the tail: no value above the cut-off is wasted', () => {
    const cut = 2 ** 48 - (2 ** 48 % 10)
    feedDraws(cut - 1)
    expect(randomInt(10)).toBe(9)
    const spy = feedDraws(cut, 3)
    spy.mockClear()
    expect(randomInt(10)).toBe(3)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('maps draws evenly on a range that does not divide 2^48: every residue gets the same number of draws', () => {
    const range = 3
    const counts = new Array<number>(range).fill(0)
    const cut = 2 ** 48 - (2 ** 48 % range)
    expect(cut % range).toBe(0)
    for (const draw of [0, 1, 2, 3, 4, 5, cut - 3, cut - 2, cut - 1]) {
      feedDraws(draw)
      counts[randomInt(range)]!++
    }
    expect(counts).toEqual([3, 3, 3])
  })

  it('answers a callback after the call returns, with no error and the value', async () => {
    feedDraws(6)
    const calls: unknown[][] = []
    const returned = randomInt(10, (...args: unknown[]) => { calls.push(args) })
    expect(returned).toBeUndefined()
    expect(calls).toEqual([])
    await Promise.resolve()
    expect(calls).toEqual([[undefined, 6]])
  })

  it('takes min, max and a callback together', async () => {
    feedDraws(2)
    const value = await new Promise<number>((resolve, reject) => {
      randomInt(100, 110, (error, result) => { if (error !== undefined) reject(error); else resolve(result) })
    })
    expect(value).toBe(102)
  })

  it('refuses an argument that is not a safe integer with ERR_INVALID_ARG_TYPE, as Node does', () => {
    for (const args of [[1.5], [1, 2.5], ['a'], [], [Number.NaN], [-(2 ** 53)], [0, 2 ** 53], [5, 'x'], [null]] as unknown[][]) {
      const real = thrown(() => (nodeRandomInt as (...rest: unknown[]) => unknown)(...args))
      const ours = thrown(() => (randomInt as (...rest: unknown[]) => unknown)(...args))
      expect(ours.code, JSON.stringify(args)).toBe('ERR_INVALID_ARG_TYPE')
      expect(ours.name).toBe('TypeError')
      expect(ours.message).toBe(real.message)
    }
  })

  it('refuses max <= min with ERR_OUT_OF_RANGE and Node\'s message', () => {
    for (const args of [[5, 5], [10, 5], [0], [-3], [2 ** 33, 2 ** 33]]) {
      const real = thrown(() => (nodeRandomInt as (...rest: number[]) => unknown)(...args))
      const ours = thrown(() => (randomInt as (...rest: number[]) => unknown)(...args))
      expect(ours.code, JSON.stringify(args)).toBe('ERR_OUT_OF_RANGE')
      expect(ours.name).toBe('RangeError')
      expect(ours.message).toBe(real.message)
    }
  })

  it('refuses a range wider than 2^48 - 1, naming max when alone and max - min when min is given', () => {
    for (const args of [[2 ** 48], [0, 2 ** 48], [-1, 2 ** 48 - 1], [2 ** 48 + 1]]) {
      const real = thrown(() => (nodeRandomInt as (...rest: number[]) => unknown)(...args))
      const ours = thrown(() => (randomInt as (...rest: number[]) => unknown)(...args))
      expect(ours.code, JSON.stringify(args)).toBe('ERR_OUT_OF_RANGE')
      expect(ours.message).toBe(real.message)
    }
  })

  it('refuses a callback that is not a function, before anything is drawn', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues')
    const real = thrown(() => (nodeRandomInt as (...rest: unknown[]) => unknown)(0, 5, 'x'))
    const ours = thrown(() => (randomInt as (...rest: unknown[]) => unknown)(0, 5, 'x'))
    expect(ours.code).toBe('ERR_INVALID_ARG_TYPE')
    expect(ours.message).toBe(real.message)
    expect(thrown(() => (randomInt as (...rest: unknown[]) => unknown)(5, 7, 'x')).message).toContain('"callback"')
    expect(spy).not.toHaveBeenCalled()
  })

  it('throws the argument errors even when a callback was given, and never calls it', () => {
    const callback = vi.fn()
    expect(thrown(() => randomInt(5, 5, callback)).code).toBe('ERR_OUT_OF_RANGE')
    expect(thrown(() => randomInt(1.5, callback as never)).code).toBe('ERR_INVALID_ARG_TYPE')
    expect(callback).not.toHaveBeenCalled()
  })
})
