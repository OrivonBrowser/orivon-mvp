import { describe, expect, it } from 'vitest'
import { APP_OPEN_BEAT_MS, askDue, askDueAt, askedNow, DAY_MS, firstSight, readAskState, startOfNextDay, stoppedAsking } from '../default-browser-ask.js'

// A fixed moment on the wall clock of whichever zone runs the test, so "the next calendar day" means the same everywhere.
const NOW = new Date(2027, 0, 15, 14, 0, 0).getTime()
const daysLater = (days: number): number => NOW + days * DAY_MS
const midnightAfterNow = new Date(2027, 0, 16, 0, 0, 0).getTime()

describe('the first ask', () => {
  const state = firstSight(NOW)

  it('does not come on the first day of use while no app has opened', () => {
    expect(askDueAt(state)).toBe(midnightAfterNow)
    expect(askDue(state, NOW)).toBe(false)
    expect(askDue(state, NOW + 60_000)).toBe(false)
    expect(askDue(state, midnightAfterNow - 1)).toBe(false)
  })

  it('comes a beat after the first app finished loading', () => {
    expect(APP_OPEN_BEAT_MS).toBe(3_000)
    const opened = NOW + 20_000
    expect(askDueAt(state, opened)).toBe(opened + APP_OPEN_BEAT_MS)
    expect(askDue(state, opened + APP_OPEN_BEAT_MS - 1, opened)).toBe(false)
    expect(askDue(state, opened + APP_OPEN_BEAT_MS, opened)).toBe(true)
  })

  it('comes on the second calendar day without any app opening', () => {
    expect(askDue(state, midnightAfterNow)).toBe(true)
    expect(askDue(state, daysLater(1))).toBe(true)
    expect(askDue(state, daysLater(5))).toBe(true)
  })

  it('counts a calendar day, not 24 hours: first used just before midnight, the next morning is the second day', () => {
    const lateEvening = firstSight(new Date(2027, 0, 15, 23, 50, 0).getTime())
    expect(askDue(lateEvening, new Date(2027, 0, 16, 0, 5, 0).getTime())).toBe(true)
    expect(askDue(lateEvening, new Date(2027, 0, 15, 23, 59, 0).getTime())).toBe(false)
  })

  it('comes at the earlier of the two', () => {
    const lateEvening = firstSight(new Date(2027, 0, 15, 23, 59, 58).getTime())
    const opened = new Date(2027, 0, 15, 23, 59, 59).getTime()
    expect(askDueAt(lateEvening, opened)).toBe(new Date(2027, 0, 16, 0, 0, 0).getTime())
  })

  it('starts the next day at local midnight', () => {
    expect(startOfNextDay(NOW)).toBe(midnightAfterNow)
    expect(startOfNextDay(new Date(2027, 0, 31, 23, 59, 59).getTime())).toBe(new Date(2027, 1, 1, 0, 0, 0).getTime())
    expect(startOfNextDay(new Date(2027, 11, 31, 12, 0, 0).getTime())).toBe(new Date(2028, 0, 1, 0, 0, 0).getTime())
  })

  it('is followed by the weekly ask, counted from its answer, whatever opened or not afterwards', () => {
    const answered = askedNow(state, NOW + 20_000)
    expect(answered.firstSeenAt).toBe(NOW)
    expect(askDue(answered, daysLater(2), NOW + 30_000)).toBe(false)
    expect(askDue(answered, NOW + 20_000 + 7 * DAY_MS - 1)).toBe(false)
    expect(askDue(answered, NOW + 20_000 + 7 * DAY_MS)).toBe(true)
  })

  it('stops for good when the person said so on the first ask', () => {
    const stopped = stoppedAsking(state)
    expect(askDueAt(stopped, NOW)).toBeUndefined()
    expect(askDue(stopped, daysLater(30), NOW)).toBe(false)
  })

  it('leaves a profile that was already asked on its weekly count: an app opening or a new day changes nothing', () => {
    const asked = { firstSeenAt: NOW - 20 * DAY_MS, lastAskedAt: NOW - 3 * DAY_MS, stopped: false }
    expect(askDueAt(asked)).toBe(NOW + 4 * DAY_MS)
    expect(askDueAt(asked, NOW)).toBe(NOW + 4 * DAY_MS)
    expect(askDue(asked, NOW + DAY_MS, NOW)).toBe(false)
  })
})

describe('the weekly ask', () => {
  const state = askedNow(firstSight(NOW), NOW)

  it('is not due on the day it was last asked, nor on day 6', () => {
    expect(askDue(state, daysLater(0))).toBe(false)
    expect(askDue(state, daysLater(6))).toBe(false)
    expect(askDue(state, NOW + 7 * DAY_MS - 1)).toBe(false)
  })

  it('is due from day 7, and stays due until it is asked', () => {
    expect(askDue(state, daysLater(7))).toBe(true)
    expect(askDue(state, daysLater(13))).toBe(true)
    expect(askDue(state, daysLater(14))).toBe(true)
  })

  it('waits another week after "Not now", counted from the answer', () => {
    const later = askedNow(state, daysLater(8))
    expect(later.firstSeenAt).toBe(NOW)
    expect(askDue(later, daysLater(8))).toBe(false)
    expect(askDue(later, daysLater(14))).toBe(false)
    expect(askDue(later, daysLater(15))).toBe(true)
  })

  it('never asks again once stopped, however long it has been, first ask or not', () => {
    for (const stopped of [stoppedAsking(state), stoppedAsking(firstSight(NOW))]) {
      expect(stopped.stopped).toBe(true)
      expect(askDueAt(stopped)).toBeUndefined()
      expect(askDue(stopped, daysLater(365))).toBe(false)
    }
  })
})

describe('reading the state back', () => {
  it('reads what was written, a first sight included', () => {
    const written = { firstSeenAt: NOW - 20 * DAY_MS, lastAskedAt: NOW - 3 * DAY_MS, stopped: false }
    expect(readAskState(JSON.stringify(written), NOW)).toEqual({ state: written, repaired: false })
    expect(readAskState(JSON.stringify(firstSight(NOW - 5_000)), NOW)).toEqual({ state: firstSight(NOW - 5_000), repaired: false })
  })

  it('has no state when the file is missing: the profile has not been seen in use', () => {
    expect(readAskState(undefined, NOW)).toEqual({ state: undefined, repaired: false })
    expect(firstSight(NOW)).toEqual({ firstSeenAt: NOW, lastAskedAt: null, stopped: false })
  })

  it('has none either when the file is corrupt or has the wrong shape', () => {
    for (const text of ['', 'not json', '[]', 'null', '{"firstSeenAt":"x","lastAskedAt":1,"stopped":false}', '{"firstSeenAt":1,"lastAskedAt":1}', '{"firstSeenAt":-1,"lastAskedAt":1,"stopped":false}', '{"firstSeenAt":1,"lastAskedAt":"x","stopped":false}']) {
      expect(readAskState(text, NOW), text).toEqual({ state: undefined, repaired: false })
    }
  })

  it('resets a time ahead of the clock to now, so a week is never counted from the future', () => {
    const ahead = { firstSeenAt: NOW + 30 * DAY_MS, lastAskedAt: NOW + 10 * DAY_MS, stopped: false }
    const { state, repaired } = readAskState(JSON.stringify(ahead), NOW)
    expect(repaired).toBe(true)
    expect(state).toEqual({ firstSeenAt: NOW, lastAskedAt: NOW, stopped: false })
    expect(askDue(state as NonNullable<typeof state>, daysLater(7))).toBe(true)
    expect(readAskState(JSON.stringify({ firstSeenAt: NOW + DAY_MS, lastAskedAt: null, stopped: false }), NOW)).toEqual({ state: firstSight(NOW), repaired: true })
  })

  it('keeps a stop through a read', () => {
    expect(readAskState(JSON.stringify({ firstSeenAt: NOW - DAY_MS, lastAskedAt: NOW - DAY_MS, stopped: true }), NOW).state?.stopped).toBe(true)
  })
})
