import { describe, expect, it, vi } from 'vitest'
import { coalesce } from '../coalesce.js'

describe('coalesce', () => {
  it('runs once for a burst inside the window', () => {
    vi.useFakeTimers()
    const run = vi.fn()
    const trigger = coalesce(run, 1000)
    trigger()
    trigger()
    trigger()
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(999)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('runs again for a burst after the window has closed', () => {
    vi.useFakeTimers()
    const run = vi.fn()
    const trigger = coalesce(run, 1000)
    trigger()
    vi.advanceTimersByTime(1000)
    expect(run).toHaveBeenCalledTimes(1)
    trigger()
    trigger()
    vi.advanceTimersByTime(1000)
    expect(run).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})
