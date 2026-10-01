import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TimedOut, withTimeout } from '../with-timeout.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('withTimeout', () => {
  it('passes the answer of work that finishes in time', async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, 'x')).resolves.toBe(7)
  })

  it('passes the failure of work that fails in time', async () => {
    await expect(withTimeout(Promise.reject(new Error('no')), 1000, 'x')).rejects.toThrow('no')
  })

  it('rejects with what did not answer when the work never settles', async () => {
    const result = withTimeout(new Promise<never>(() => {}), 500, 'the page')
    const settled = expect(result).rejects.toBeInstanceOf(TimedOut)
    await vi.advanceTimersByTimeAsync(500)
    await settled
  })

  it('leaves no timer behind', async () => {
    await withTimeout(Promise.resolve(1), 1000, 'x')
    expect(vi.getTimerCount()).toBe(0)
  })
})
