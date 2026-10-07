import { describe, expect, it } from 'vitest'
import { askDue, askDueAt, askedNow, canStop, DAY_MS, FIRST_ASK_AFTER_MS, firstSight, readAskState, stoppedAsking } from '../default-browser-ask.js'

const NOW = 1_800_000_000_000
const daysLater = (days: number): number => NOW + days * DAY_MS

describe('the first ask', () => {
  const state = firstSight(NOW)

  it('comes half a minute after the profile is first seen in use, not before', () => {
    expect(FIRST_ASK_AFTER_MS).toBe(30_000)
    expect(askDueAt(state)).toBe(NOW + FIRST_ASK_AFTER_MS)
    expect(askDue(state, NOW)).toBe(false)
    expect(askDue(state, NOW + FIRST_ASK_AFTER_MS - 1)).toBe(false)
    expect(askDue(state, NOW + FIRST_ASK_AFTER_MS)).toBe(true)
  })

  it('offers no "Don\'t ask again" yet', () => {
    expect(canStop(state, NOW + FIRST_ASK_AFTER_MS)).toBe(false)
  })

  it('is followed by the weekly ask, counted from its answer', () => {
    const answered = askedNow(state, NOW + FIRST_ASK_AFTER_MS)
    expect(answered.firstSeenAt).toBe(NOW)
    expect(askDue(answered, NOW + FIRST_ASK_AFTER_MS + 7 * DAY_MS - 1)).toBe(false)
    expect(askDue(answered, NOW + FIRST_ASK_AFTER_MS + 7 * DAY_MS)).toBe(true)
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

  it('offers "Don\'t ask again" only from day 14 after the profile was first seen', () => {
    expect(canStop(state, daysLater(0))).toBe(false)
    expect(canStop(state, daysLater(7))).toBe(false)
    expect(canStop(state, daysLater(13))).toBe(false)
    expect(canStop(state, daysLater(14))).toBe(true)
    expect(canStop(state, daysLater(40))).toBe(true)
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
