import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResolutionError } from '../../resolution/records.js'
import { retryWhileWanted } from '../fetch-passes.js'
import type { PatientRetry } from '../fetch-passes.js'

const RETRY: PatientRetry = { waitMs: 32_000, maxRetries: 2, startByMs: 90_000 }

const unavailable = (): ResolutionError => new ResolutionError('unavailable', 'node answered 404')

/** An attempt that fails with `errors` in turn (taking `takes` ms each), then returns 'block'. */
function attempts (errors: readonly unknown[], takes = 0): { run: () => Promise<string>, calls: () => number } {
  let calls = 0
  return {
    calls: () => calls,
    run: async () => {
      const error = errors[calls++]
      if (takes > 0) await new Promise((resolve) => setTimeout(resolve, takes))
      if (error !== undefined) throw error
      return 'block'
    }
  }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('retryWhileWanted', () => {
  it('returns at once, waiting for nothing, when the first try serves', async () => {
    const attempt = attempts([])
    expect(await retryWhileWanted(attempt.run, RETRY, Date.now, new AbortController().signal)).toBe('block')
    expect(attempt.calls()).toBe(1)
  })

  it('asks again only after the wait, and serves what the node has by then', async () => {
    const attempt = attempts([unavailable()])
    const result = retryWhileWanted(attempt.run, RETRY, Date.now, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(RETRY.waitMs - 1)
    expect(attempt.calls()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toBe('block')
    expect(attempt.calls()).toBe(2)
  })

  it('stops after maxRetries and throws the last failure', async () => {
    const last = new ResolutionError('unavailable', 'third')
    const attempt = attempts([unavailable(), unavailable(), last, unavailable()])
    const result = retryWhileWanted(attempt.run, RETRY, Date.now, new AbortController().signal)
    const settled = expect(result).rejects.toBe(last)
    await vi.advanceTimersByTimeAsync(RETRY.waitMs * 5)
    await settled
    expect(attempt.calls()).toBe(3)
  })

  it('starts no retry later than startByMs after the first try began: a first try that spent its whole timeout gets one retry', async () => {
    const attempt = attempts([unavailable(), unavailable(), unavailable()], 45_000)
    const result = retryWhileWanted(attempt.run, RETRY, Date.now, new AbortController().signal)
    const settled = expect(result).rejects.toMatchObject({ failure: 'unavailable' })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await settled
    expect(attempt.calls()).toBe(2)
  })

  it.each(['unverifiable', 'unsupported', 'invalid-name', 'not-found'] as const)('never asks again after a %s failure', async (failure) => {
    const attempt = attempts([new ResolutionError(failure, 'no')])
    await expect(retryWhileWanted(attempt.run, RETRY, Date.now, new AbortController().signal)).rejects.toMatchObject({ failure })
    expect(attempt.calls()).toBe(1)
  })

  it('never asks again after an error that is not a ResolutionError', async () => {
    const bug = new TypeError('bug')
    const attempt = attempts([bug])
    await expect(retryWhileWanted(attempt.run, RETRY, Date.now, new AbortController().signal)).rejects.toBe(bug)
    expect(attempt.calls()).toBe(1)
  })

  it('stops waiting the moment the caller leaves, and asks nothing more', async () => {
    const attempt = attempts([unavailable()])
    const controller = new AbortController()
    const result = retryWhileWanted(attempt.run, RETRY, Date.now, controller.signal)
    const settled = expect(result).rejects.toMatchObject({ failure: 'unavailable' })
    await vi.advanceTimersByTimeAsync(1_000)
    controller.abort(new Error('the client went away'))
    await settled
    expect(attempt.calls()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not wait at all when the caller has already left', async () => {
    const attempt = attempts([unavailable()])
    const controller = new AbortController()
    controller.abort(new Error('gone'))
    await expect(retryWhileWanted(attempt.run, RETRY, Date.now, controller.signal)).rejects.toMatchObject({ failure: 'unavailable' })
    expect(attempt.calls()).toBe(1)
  })
})
