import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StallClock } from '../stall.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

const WINDOWS = { firstByteMs: 10_000, stallMs: 4_000, capMs: 60_000 }

describe('a transfer that fails when it stops moving', () => {
  it('ends when the first byte takes longer than its window', () => {
    const clock = new StallClock(WINDOWS)
    vi.advanceTimersByTime(9_999)
    expect(clock.signal.aborted).toBe(false)
    vi.advanceTimersByTime(1)
    expect(clock.signal.aborted).toBe(true)
    expect(clock.reason).toBe('first-byte')
  })

  it('does not end a body that keeps sending, however long it takes in all', () => {
    const clock = new StallClock(WINDOWS)
    vi.advanceTimersByTime(8_000)
    for (let i = 0; i < 12; i++) {
      clock.progress()
      vi.advanceTimersByTime(3_900)
    }
    expect(clock.signal.aborted).toBe(false)
    clock.finish()
  })

  it('ends a body that goes quiet for longer than the stall window', () => {
    const clock = new StallClock(WINDOWS)
    clock.progress()
    vi.advanceTimersByTime(3_999)
    expect(clock.signal.aborted).toBe(false)
    vi.advanceTimersByTime(1)
    expect(clock.reason).toBe('stall')
  })

  it('ends a source that trickles for ever at the cap', () => {
    const clock = new StallClock(WINDOWS)
    for (let elapsed = 0; elapsed < 60_000; elapsed += 3_000) {
      clock.progress()
      vi.advanceTimersByTime(3_000)
    }
    expect(clock.signal.aborted).toBe(true)
    expect(clock.reason).toBe('cap')
  })

  it('stops its clocks once finished, and fires nothing afterwards', () => {
    const clock = new StallClock(WINDOWS)
    clock.finish()
    vi.advanceTimersByTime(120_000)
    expect(clock.signal.aborted).toBe(false)
  })
})
