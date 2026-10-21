import { describe, expect, it } from 'vitest'
import { createProfileDemand, WAKE_GRACE_MS } from '../profile-demand.js'

function clock () {
  let now = 1_000
  let timer: { run: () => void, at: number } | undefined
  return {
    now: () => now,
    setTimer: (run: () => void, ms: number) => { timer = { run, at: now + ms }; return timer },
    clearTimer: (handle: unknown) => { if (timer === handle) timer = undefined },
    advance (ms: number) {
      now += ms
      if (timer !== undefined && timer.at <= now) {
        const due = timer
        timer = undefined
        due.run()
      }
    }
  }
}

describe('whether a profile has a reason to run the extensions', () => {
  it('is no while nothing is open, yes while a page is, and no again once the last one closes', () => {
    const demand = createProfileDemand(clock())
    const seen: boolean[] = []
    demand.onChange((open) => seen.push(open))
    expect(demand.isOpen()).toBe(false)
    demand.opened(1)
    demand.opened(2)
    demand.closed(1)
    expect(demand.isOpen()).toBe(true)
    demand.closed(2)
    expect(demand.isOpen()).toBe(false)
    expect(seen).toEqual([true, false])
  })

  it('counts a view about to be made as open, and gives it up when the view never comes', () => {
    const time = clock()
    const demand = createProfileDemand(time)
    const seen: boolean[] = []
    demand.onChange((open) => seen.push(open))
    demand.wake()
    expect(demand.isOpen()).toBe(true)
    time.advance(WAKE_GRACE_MS + 5)
    expect(demand.isOpen()).toBe(false)
    expect(seen).toEqual([true, false])
  })

  it('lets the page that arrives hold the answer, so closing it ends it at once and not when the wake would have run out', () => {
    const time = clock()
    const demand = createProfileDemand(time)
    const seen: boolean[] = []
    demand.onChange((open) => seen.push(open))
    demand.wake()
    demand.opened(7)
    demand.closed(7)
    expect(demand.isOpen()).toBe(false)
    expect(seen).toEqual([true, false])
  })

  it('ignores the close of a page it never heard open, and says nothing when the answer does not change', () => {
    const demand = createProfileDemand(clock())
    const seen: boolean[] = []
    demand.onChange((open) => seen.push(open))
    demand.closed(3)
    demand.opened(4)
    demand.opened(4)
    expect(seen).toEqual([true])
  })

  it('does not count a page that shows an extension, and asks again after a navigation', () => {
    const demand = createProfileDemand(clock())
    const seen: boolean[] = []
    demand.onChange((open) => seen.push(open))
    let site = true
    demand.opened(1, () => site)
    demand.opened(2, () => false)
    expect(demand.isOpen()).toBe(true)
    site = false
    expect(demand.isOpen(), 'the tab was sent to an extension page').toBe(false)
    demand.recheck()
    expect(seen).toEqual([true, false])
    site = true
    demand.recheck()
    expect(seen).toEqual([true, false, true])
  })
})
