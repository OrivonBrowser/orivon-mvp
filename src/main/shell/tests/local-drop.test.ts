import { describe, expect, it } from 'vitest'
import { ARRIVAL_FRESH_MS, ARRIVAL_WAIT_MS, ArrivalBook, ghostPointFor, planLocalDrop } from '../local-drop.js'
import type { Arrival, ArrivalClock } from '../local-drop.js'

type Win = 'a' | 'b' | 'c'
const content = { width: 1000, height: 700 }
const TOP = 76
const slotOf = (_window: Win, x: number): number => Math.floor(x / 100)

const plan = (client: { x: number, y: number }, extra: { zone?: 'left' | null, arrival?: Arrival<Win> | null } = {}) =>
  planLocalDrop<Win>({ client, content, topHeight: TOP, zone: extra.zone ?? null, arrival: extra.arrival ?? null, slotOf })
const arrival = (window: Win, x: number, y: number, width = 800): Arrival<Win> => ({ window, x, y, width })

describe('planLocalDrop', () => {
  it('splits on a split edge, whatever else was seen', () => {
    expect(plan({ x: 10, y: 300 }, { zone: 'left', arrival: arrival('b', 150, 20) })).toEqual({ kind: 'split', zone: 'left' })
  })

  it('moves the tab into the window the pointer arrived over, at the slot under it', () => {
    expect(plan({ x: -300, y: 20 }, { arrival: arrival('b', 350, 20) })).toEqual({ kind: 'move', window: 'b', index: 3 })
  })

  it('moves it even when the point in the source window is inside the source\'s own top rows (a window stacked over it)', () => {
    expect(plan({ x: 400, y: 20 }, { arrival: arrival('b', 120, 30) })).toEqual({ kind: 'move', window: 'b', index: 1 })
  })

  it('opens a window of its own when the arrival is below the other window\'s top rows', () => {
    expect(plan({ x: -300, y: 400 }, { arrival: arrival('b', 150, TOP) })).toEqual({ kind: 'window' })
  })

  it('opens a window of its own for an arrival outside the other window\'s width', () => {
    expect(plan({ x: -300, y: 400 }, { arrival: arrival('b', 800, 20, 800) })).toEqual({ kind: 'window' })
  })

  it('does nothing over the source\'s own strip or toolbar', () => {
    expect(plan({ x: 500, y: 0 })).toEqual({ kind: 'stay' })
    expect(plan({ x: 0, y: TOP - 1 })).toEqual({ kind: 'stay' })
  })

  it('opens a window of its own over the source\'s page, below it, and beside or above it', () => {
    expect(plan({ x: 500, y: TOP })).toEqual({ kind: 'window' })
    expect(plan({ x: 500, y: 2000 })).toEqual({ kind: 'window' })
    expect(plan({ x: -5, y: 20 })).toEqual({ kind: 'window' })
    expect(plan({ x: 1000, y: 20 })).toEqual({ kind: 'window' })
    expect(plan({ x: 500, y: -5 })).toEqual({ kind: 'window' })
  })
})

describe('ghostPointFor', () => {
  it('follows the pointer over the page, away from a split edge', () => {
    expect(ghostPointFor({ x: 400, y: 300 }, content, TOP, false)).toEqual({ x: 400, y: 300 })
  })

  it('is hidden over the strip and toolbar, on a split edge, and outside the window', () => {
    expect(ghostPointFor({ x: 400, y: TOP - 1 }, content, TOP, false)).toBeNull()
    expect(ghostPointFor({ x: 400, y: 300 }, content, TOP, true)).toBeNull()
    expect(ghostPointFor({ x: -1, y: 300 }, content, TOP, false)).toBeNull()
    expect(ghostPointFor({ x: 1000, y: 300 }, content, TOP, false)).toBeNull()
    expect(ghostPointFor({ x: 400, y: 700 }, content, TOP, false)).toBeNull()
  })
})

/** A clock the test winds by hand. */
function fakeClock (): ArrivalClock & { advance: (ms: number) => void } {
  let now = 1000
  let timers: Array<{ at: number, fn: () => void }> = []
  return {
    now: () => now,
    after: (ms, fn) => {
      const timer = { at: now + ms, fn }
      timers.push(timer)
      return () => { timers = timers.filter((candidate) => candidate !== timer) }
    },
    advance: (ms) => {
      now += ms
      const due = timers.filter((timer) => timer.at <= now)
      timers = timers.filter((timer) => timer.at > now)
      for (const timer of due) timer.fn()
    }
  }
}

describe('ArrivalBook', () => {
  it('answers at once with an arrival that came just before', async () => {
    const clock = fakeClock()
    const book = new ArrivalBook<Win>(clock)
    book.record(arrival('b', 10, 10))
    clock.advance(ARRIVAL_FRESH_MS - 1)
    expect(await book.settle()).toEqual(arrival('b', 10, 10))
  })

  it('does not count an arrival that is older than the drop by more than the fresh window', async () => {
    const clock = fakeClock()
    const book = new ArrivalBook<Win>(clock)
    book.record(arrival('b', 10, 10))
    clock.advance(ARRIVAL_FRESH_MS + 1)
    const settled = book.settle()
    clock.advance(ARRIVAL_WAIT_MS)
    expect(await settled).toBeNull()
  })

  it('answers with an arrival that comes after the drop, without waiting out the rest', async () => {
    const clock = fakeClock()
    const book = new ArrivalBook<Win>(clock)
    const settled = book.settle()
    clock.advance(40)
    book.record(arrival('c', 5, 5))
    expect(await settled).toEqual(arrival('c', 5, 5))
  })

  it('answers null when nothing arrives in time', async () => {
    const clock = fakeClock()
    const book = new ArrivalBook<Win>(clock)
    const settled = book.settle()
    clock.advance(ARRIVAL_WAIT_MS - 1)
    let done = false
    void settled.then(() => { done = true })
    await Promise.resolve()
    expect(done).toBe(false)
    clock.advance(1)
    expect(await settled).toBeNull()
  })

  it('keeps the first arrival of a window and the latest of several windows', async () => {
    const clock = fakeClock()
    const book = new ArrivalBook<Win>(clock)
    book.record(arrival('b', 1, 1))
    clock.advance(10)
    book.record(arrival('b', 2, 2))
    clock.advance(10)
    book.record(arrival('c', 3, 3))
    expect(await book.settle()).toEqual(arrival('c', 3, 3))
    clock.advance(0)
    expect(book.fresh()?.window).toBe('c')
  })

  it('forgets everything on clear, and lets a waiting drop go with null', async () => {
    const clock = fakeClock()
    const book = new ArrivalBook<Win>(clock)
    book.record(arrival('b', 1, 1))
    book.clear()
    const settled = book.settle()
    book.clear()
    expect(await settled).toBeNull()
    expect(book.fresh()).toBeNull()
  })
})
