import { describe, expect, it } from 'vitest'
import {
  afterSent,
  initialKindSchedule,
  isOffsetStale,
  periodsDue,
  pickSendOffsetMs,
  previousPeriod,
  SEND_OFFSET_WINDOW_MS,
  SNAPSHOT_EVERY_MS,
  withOffsetFor
} from '../schedule.js'

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

describe('periodsDue', () => {
  const september = Date.UTC(2026, 8, 1)
  const october = Date.UTC(2026, 9, 1)
  const offset = 3 * 60 * 60 * 1000
  const scheduled = { ...initialKindSchedule, offsetPeriod: '2026-10', offsetMs: offset }
  const data = (period: string): boolean => period === '2026-09' || period === '2026-10'

  it('waits for the period offset before anything, and for the offset to be drawn', () => {
    expect(periodsDue(october + offset - 1, '2026-10', scheduled, data)).toEqual([])
    expect(periodsDue(october + offset, '2026-10', initialKindSchedule, data)).toEqual([])
  })

  it('stages the closing snapshot of the previous period first, then the running one', () => {
    expect(periodsDue(october + offset, '2026-10', scheduled, data)).toEqual(['2026-09', '2026-10'])
  })

  it('stages the closing snapshot once, and only for a period that had data', () => {
    expect(periodsDue(october + offset, '2026-10', { ...scheduled, closedPeriod: '2026-09' }, data)).toEqual(['2026-10'])
    expect(periodsDue(october + offset, '2026-10', scheduled, (period) => period === '2026-10')).toEqual(['2026-10'])
  })

  it('stages the running snapshot at most once every 24 hours', () => {
    const sent = { ...scheduled, closedPeriod: '2026-09', lastSentAtMs: october + offset }
    expect(periodsDue(october + offset + SNAPSHOT_EVERY_MS - 1, '2026-10', sent, data)).toEqual([])
    expect(periodsDue(october + offset + SNAPSHOT_EVERY_MS, '2026-10', sent, data)).toEqual(['2026-10'])
  })

  it('immediate ignores the random offset and the 24-hour gate, and always stages the running period', () => {
    expect(periodsDue(october + offset - 1, '2026-10', scheduled, data, SNAPSHOT_EVERY_MS, true)).toEqual(['2026-09', '2026-10'])
    expect(periodsDue(october + 1, '2026-10', initialKindSchedule, data, SNAPSHOT_EVERY_MS, true)).toEqual(['2026-09', '2026-10'])
    const sent = { ...scheduled, closedPeriod: '2026-09', lastSentAtMs: october + offset }
    expect(periodsDue(october + offset + 1000, '2026-10', sent, data, SNAPSHOT_EVERY_MS, true)).toEqual(['2026-10'])
  })

  it('immediate still stages the closing snapshot once, and only for a period that had data', () => {
    expect(periodsDue(october + 1, '2026-10', { ...scheduled, closedPeriod: '2026-09' }, data, SNAPSHOT_EVERY_MS, true)).toEqual(['2026-10'])
    expect(periodsDue(october + 1, '2026-10', scheduled, (period) => period === '2026-10', SNAPSHOT_EVERY_MS, true)).toEqual(['2026-10'])
  })

  it('treats a snapshot sent in an earlier period as not sent in this one', () => {
    const old = { ...scheduled, closedPeriod: '2026-09', lastSentAtMs: september + 5000 }
    expect(periodsDue(october + offset, '2026-10', old, data)).toEqual(['2026-10'])
  })
})

describe('afterSent and withOffsetFor', () => {
  it('settles a period when its closing snapshot goes, and starts the 24-hour clock otherwise', () => {
    const now = Date.UTC(2026, 9, 2)
    const closed = afterSent(initialKindSchedule, '2026-09', Date.UTC(2026, 9, 2), now)
    expect(closed).toMatchObject({ closedPeriod: '2026-09', lastSentAtMs: undefined })
    const running = afterSent(initialKindSchedule, '2026-10', Date.UTC(2026, 9, 2), now)
    expect(running).toMatchObject({ closedPeriod: undefined, lastSentAtMs: now })
  })

  it('does not call a snapshot of September taken in September closing', () => {
    expect(afterSent(initialKindSchedule, '2026-09', Date.UTC(2026, 8, 20), Date.UTC(2026, 8, 20)).closedPeriod).toBeUndefined()
  })

  it('draws a new offset only when the period changes', () => {
    const first = withOffsetFor(initialKindSchedule, '2026-10', () => 0.5)
    expect(first).toMatchObject({ offsetPeriod: '2026-10', offsetMs: Math.floor(0.5 * SEND_OFFSET_WINDOW_MS) })
    expect(withOffsetFor(first, '2026-10', () => 0.9)).toBe(first)
    expect(withOffsetFor(first, '2026-11', () => 0).offsetMs).toBe(0)
  })

  it('finds the previous period across a year boundary', () => {
    expect(previousPeriod('2027-01')).toBe('2026-12')
    expect(previousPeriod('2026-10')).toBe('2026-09')
  })
})
