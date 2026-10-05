import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OPEN_TAB_CHECK_MS, startUpdateWatch } from '../update-watch.js'

// An open app tab is looked at every interval, once per origin however many
// windows show it, and a check that is slow or throws never piles up.

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('startUpdateWatch', () => {
  it('checks each origin with an open tab once per interval, though two windows show it', async () => {
    const check = vi.fn(async (_origin: string) => {})
    startUpdateWatch({ openOrigins: () => ['https://a.eth', 'https://a.eth', 'https://b.eth'], check, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(999)
    expect(check).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(check.mock.calls.map(([origin]) => origin)).toEqual(['https://a.eth', 'https://b.eth'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(check).toHaveBeenCalledTimes(4)
  })

  it('checks nothing when no tab is open', async () => {
    const check = vi.fn(async (_origin: string) => {})
    startUpdateWatch({ openOrigins: () => [], check, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(5000)
    expect(check).not.toHaveBeenCalled()
  })

  it('does not start a second check of an origin whose last one has not finished', async () => {
    let release: () => void = () => {}
    const check = vi.fn(async (_origin: string) => await new Promise<void>((resolve) => { release = resolve }))
    startUpdateWatch({ openOrigins: () => ['https://a.eth'], check, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(3000)
    expect(check).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(1000)
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('survives a check that throws, and stops when asked', async () => {
    const check = vi.fn(async (_origin: string) => { throw new Error('offline') })
    const stop = startUpdateWatch({ openOrigins: () => ['https://a.eth'], check, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(2000)
    expect(check).toHaveBeenCalledTimes(2)
    stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('defaults to every 30 minutes', () => {
    expect(OPEN_TAB_CHECK_MS).toBe(30 * 60_000)
  })
})
