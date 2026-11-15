import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { racePass } from '../race.js'
import type { AttemptOutcome } from '../race.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

/** Candidates that each answer `value` after `delays[candidate]` ms (never, for a candidate left out), and the signals they were given. */
function sources (delays: Readonly<Record<string, number>>, values: Readonly<Record<string, number>>): { run: (candidate: string, signal: AbortSignal) => Promise<AttemptOutcome<number>>, signals: Map<string, AbortSignal> } {
  const signals = new Map<string, AbortSignal>()
  return {
    signals,
    run: async (candidate, signal) => {
      signals.set(candidate, signal)
      await new Promise<void>((resolve, reject) => {
        const delay = delays[candidate]
        const timer = delay === undefined ? undefined : setTimeout(resolve, delay)
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
      })
      return { kind: 'verified', value: values[candidate]! }
    }
  }
}

const never = new AbortController().signal

describe('racePass', () => {
  it('returns the first verified answer at once and abandons the other attempt', async () => {
    const { run, signals } = sources({ a: 100, b: 10 }, { a: 1, b: 9 })
    const result = racePass(['a', 'b'], run, 20, never)
    await vi.advanceTimersByTimeAsync(30)
    expect(await result).toEqual({ kind: 'verified', value: 9 })
    expect(signals.get('a')?.aborted).toBe(true)
  })

  describe('with a settle', () => {
    const settle = { graceMs: 500, prefers: (candidate: number, current: number) => candidate > current }

    it('keeps both attempts busy through the grace and returns the preferred answer', async () => {
      const { run, signals } = sources({ a: 0, b: 200, c: 300, d: 900 }, { a: 1, b: 7, c: 4, d: 99 })
      const result = racePass(['a', 'b', 'c', 'd'], run, 60_000, never, settle)
      await vi.advanceTimersByTimeAsync(499)
      expect(signals.has('d')).toBe(true)
      await vi.advanceTimersByTimeAsync(1)
      expect(await result).toEqual({ kind: 'verified', value: 7 })
      expect(signals.get('d')?.aborted).toBe(true)
    })

    it('keeps the earlier answer on a tie', async () => {
      const { run } = sources({ a: 0, b: 100 }, { a: 5, b: 5 })
      const result = racePass(['a', 'b'], run, 60_000, never, { ...settle, prefers: () => false })
      await vi.advanceTimersByTimeAsync(100)
      expect(await result).toEqual({ kind: 'verified', value: 5 })
    })

    it('ends at once when nothing is left to ask, and leaves no timer behind', async () => {
      const { run } = sources({ a: 0, b: 100 }, { a: 1, b: 2 })
      const result = racePass(['a', 'b'], run, 60_000, never, settle)
      await vi.advanceTimersByTimeAsync(100)
      expect(await result).toEqual({ kind: 'verified', value: 2 })
      expect(vi.getTimerCount()).toBe(0)
    })

    it('still ends with the caller\'s own reason when the caller leaves during the grace', async () => {
      const { run } = sources({ a: 0 }, { a: 1 })
      const caller = new AbortController()
      const reason = new Error('left')
      const result = racePass(['a', 'b'], run, 60_000, caller.signal, settle)
      const rejected = expect(result).rejects.toBe(reason)
      await vi.advanceTimersByTimeAsync(100)
      caller.abort(reason)
      await rejected
    })
  })
})
