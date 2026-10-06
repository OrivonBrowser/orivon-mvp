import { describe, expect, it } from 'vitest'
import { askDue, askedNow, canStop, DAY_MS, firstSight, readAskState, stoppedAsking } from '../default-browser-ask.js'

const NOW = 1_800_000_000_000
const daysLater = (days: number): number => NOW + days * DAY_MS

describe('the weekly ask', () => {
  const state = firstSight(NOW)

  it('is not due on the day it was seen, nor on day 6', () => {
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

  it('never asks again once stopped, however long it has been', () => {
    const stopped = stoppedAsking(state)
    expect(stopped.stopped).toBe(true)
    expect(askDue(stopped, daysLater(365))).toBe(false)
  })
})

describe('reading the state back', () => {
  it('reads what was written', () => {
    const written = { firstSeenAt: NOW - 20 * DAY_MS, lastAskedAt: NOW - 3 * DAY_MS, stopped: false }
    expect(readAskState(JSON.stringify(written), NOW)).toEqual({ state: written, repaired: false })
  })

  it('makes a state of its own when the file is missing, asked just now', () => {
    expect(readAskState(undefined, NOW)).toEqual({ state: firstSight(NOW), repaired: true })
    expect(firstSight(NOW)).toEqual({ firstSeenAt: NOW, lastAskedAt: NOW, stopped: false })
  })

  it('makes it again when the file is corrupt or has the wrong shape', () => {
    for (const text of ['', 'not json', '[]', 'null', '{"firstSeenAt":"x","lastAskedAt":1,"stopped":false}', '{"firstSeenAt":1,"lastAskedAt":1}', '{"firstSeenAt":-1,"lastAskedAt":1,"stopped":false}']) {
      expect(readAskState(text, NOW), text).toEqual({ state: firstSight(NOW), repaired: true })
    }
  })

  it('resets a time ahead of the clock to now, so a week is never counted from the future', () => {
    const ahead = { firstSeenAt: NOW + 30 * DAY_MS, lastAskedAt: NOW + 10 * DAY_MS, stopped: false }
    const { state, repaired } = readAskState(JSON.stringify(ahead), NOW)
    expect(repaired).toBe(true)
    expect(state).toEqual({ firstSeenAt: NOW, lastAskedAt: NOW, stopped: false })
    expect(askDue(state, daysLater(7))).toBe(true)
  })

  it('keeps a stop through a read', () => {
    expect(readAskState(JSON.stringify({ firstSeenAt: NOW - DAY_MS, lastAskedAt: NOW - DAY_MS, stopped: true }), NOW).state.stopped).toBe(true)
  })
})
