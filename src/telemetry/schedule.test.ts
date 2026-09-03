import { describe, expect, it } from 'vitest'
import {
  isOffsetStale,
  pickSendOffsetMs,
  SEND_OFFSET_WINDOW_MS
} from './schedule.js'

describe('pickSendOffsetMs', () => {
  it('scales the injected [0,1) random source into [0, windowMs)', () => {
    expect(pickSendOffsetMs(() => 0, 1000)).toBe(0)
    expect(pickSendOffsetMs(() => 0.5, 1000)).toBe(500)
    // Never reaches windowMs itself -- Math.random()'s own contract is [0, 1).
    expect(pickSendOffsetMs(() => 0.999999, 1000)).toBeLessThan(1000)
  })

  it('defaults to SEND_OFFSET_WINDOW_MS when no window is given', () => {
    const offset = pickSendOffsetMs(() => 0.5)
    expect(offset).toBe(Math.floor(0.5 * SEND_OFFSET_WINDOW_MS))
  })

  it('is always a non-negative integer', () => {
    const offset = pickSendOffsetMs(() => 0.123456789, 60_000)
    expect(Number.isInteger(offset)).toBe(true)
    expect(offset).toBeGreaterThanOrEqual(0)
  })
})

describe('isOffsetStale', () => {
  it('is stale when no offset has been computed yet', () => {
    expect(isOffsetStale(undefined, '2026-09')).toBe(true)
  })

  it('is stale once the calendar period has rolled over', () => {
    expect(isOffsetStale('2026-09', '2026-10')).toBe(true)
  })

  it('is not stale while still inside the period the offset was computed for', () => {
    expect(isOffsetStale('2026-09', '2026-09')).toBe(false)
  })
})
