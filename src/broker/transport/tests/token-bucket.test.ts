import { describe, expect, it } from 'vitest'
import { createTokenBucketLimiter } from '../token-bucket.js'

const APP = 'https://app.example'
const OTHER = 'https://other.example'

/** A clock a test can advance deterministically -- no real timers anywhere in this file. */
function fakeClock (startMs = 0): { now: () => number, advance: (ms: number) => void } {
  let current = startMs
  return {
    now: () => current,
    advance: (ms) => { current += ms }
  }
}

describe('createTokenBucketLimiter', () => {
  it('the first call for a fresh origin succeeds -- the bucket starts full', () => {
    const clock = fakeClock()
    const limiter = createTokenBucketLimiter({ capacity: 5, refillPerSecond: 1, now: clock.now })

    expect(limiter.tryConsume(APP)).toBe(true)
  })

  it('exactly `capacity` calls succeed back-to-back with no time elapsed; the next one fails', () => {
    const clock = fakeClock()
    const limiter = createTokenBucketLimiter({ capacity: 3, refillPerSecond: 1, now: clock.now })

    expect(limiter.tryConsume(APP)).toBe(true)
    expect(limiter.tryConsume(APP)).toBe(true)
    expect(limiter.tryConsume(APP)).toBe(true)
    expect(limiter.tryConsume(APP)).toBe(false)
  })

  it('a failed call spends no token -- retrying immediately still fails, not succeeds', () => {
    const clock = fakeClock()
    const limiter = createTokenBucketLimiter({ capacity: 1, refillPerSecond: 1, now: clock.now })
    limiter.tryConsume(APP) // spends the only token
    expect(limiter.tryConsume(APP)).toBe(false)

    expect(limiter.tryConsume(APP)).toBe(false)
  })

  it('refilling exactly one token worth of time allows exactly one more call, no more', () => {
    const clock = fakeClock()
    const limiter = createTokenBucketLimiter({ capacity: 1, refillPerSecond: 2, now: clock.now }) // 500ms per token
    limiter.tryConsume(APP)
    expect(limiter.tryConsume(APP)).toBe(false)

    clock.advance(500)

    expect(limiter.tryConsume(APP)).toBe(true)
    expect(limiter.tryConsume(APP)).toBe(false)
  })

  it('refill never exceeds capacity, however long the clock advances', () => {
    const clock = fakeClock()
    const limiter = createTokenBucketLimiter({ capacity: 3, refillPerSecond: 1, now: clock.now })
    limiter.tryConsume(APP)
    limiter.tryConsume(APP)
    limiter.tryConsume(APP)
    expect(limiter.tryConsume(APP)).toBe(false)

    clock.advance(1_000_000_000) // an enormous amount of elapsed time

    // Capacity is 3, not unlimited: exactly 3 calls succeed, the 4th does not.
    expect(limiter.tryConsume(APP)).toBe(true)
    expect(limiter.tryConsume(APP)).toBe(true)
    expect(limiter.tryConsume(APP)).toBe(true)
    expect(limiter.tryConsume(APP)).toBe(false)
  })

  it('refill is continuous and fractional, not a discrete step at the full-token boundary', () => {
    const clock = fakeClock()
    const limiter = createTokenBucketLimiter({ capacity: 1, refillPerSecond: 1, now: clock.now }) // 1000ms per token
    limiter.tryConsume(APP)
    expect(limiter.tryConsume(APP)).toBe(false)

    clock.advance(500) // half the time for one token
    expect(limiter.tryConsume(APP)).toBe(false)

    clock.advance(500) // the other half -- now a full token's worth has elapsed in total
    expect(limiter.tryConsume(APP)).toBe(true)
  })

  it('two origins have fully independent buckets', () => {
    const clock = fakeClock()
    const limiter = createTokenBucketLimiter({ capacity: 1, refillPerSecond: 1, now: clock.now })
    limiter.tryConsume(APP) // exhausts APP's bucket

    expect(limiter.tryConsume(APP)).toBe(false)
    expect(limiter.tryConsume(OTHER)).toBe(true) // OTHER's bucket is untouched
  })

  it('refill is driven only by the injected clock, never a hidden wall-clock read', () => {
    const clock = fakeClock(1_000_000) // an arbitrary, real-time-unrelated starting point
    const limiter = createTokenBucketLimiter({ capacity: 1, refillPerSecond: 1, now: clock.now })
    limiter.tryConsume(APP)
    expect(limiter.tryConsume(APP)).toBe(false)

    clock.advance(1_000) // exactly one token's worth, per the injected clock alone

    expect(limiter.tryConsume(APP)).toBe(true)
  })

  it('a clock that reports no elapsed time between two calls behaves safely (no negative-elapsed refill)', () => {
    const clock = fakeClock()
    const limiter = createTokenBucketLimiter({ capacity: 1, refillPerSecond: 1, now: clock.now })
    limiter.tryConsume(APP)

    expect(limiter.tryConsume(APP)).toBe(false)
    expect(limiter.tryConsume(APP)).toBe(false)
  })
})

// R1-02: without this, an origin that calls once and never returns keeps a
// permanent row in `buckets` forever -- see ../token-bucket.ts's `reapIdle`.
describe('createTokenBucketLimiter -- reaping an idle origin (R1-02)', () => {
  it('an idle origin\'s bucket is eventually reaped once another call ticks the clock past its full refill', () => {
    const clock = fakeClock()
    const limiter = createTokenBucketLimiter({ capacity: 2, refillPerSecond: 1, now: clock.now })
    limiter.tryConsume(APP) // APP now holds a row (1 of 2 tokens spent), and never calls again
    expect(limiter.size()).toBe(1)

    clock.advance(5000) // far more than enough time for APP's bucket to fully recover
    limiter.tryConsume(OTHER) // any call ticks the sweep, not only one from APP itself

    // APP's stale row is gone; only OTHER's fresh one remains -- if it were
    // never reaped, size would be 2 here.
    expect(limiter.size()).toBe(1)
  })

  it('a reaped origin\'s next call behaves exactly like a first-ever call -- no free burst, no leftover throttle', () => {
    const clock = fakeClock()
    const limiter = createTokenBucketLimiter({ capacity: 1, refillPerSecond: 1, now: clock.now })
    limiter.tryConsume(APP) // spends APP's only token
    expect(limiter.tryConsume(APP)).toBe(false) // confirmed throttled before any reap

    clock.advance(10_000) // long enough to fully refill, and to be swept
    limiter.tryConsume(OTHER) // ticks the sweep; APP's now-recovered bucket is reaped

    // Same shape as a never-seen origin: succeeds once, then throttles --
    // not two-in-a-row (a free burst) and not still-false (leftover state).
    expect(limiter.tryConsume(APP)).toBe(true)
    expect(limiter.tryConsume(APP)).toBe(false)
  })

  it('an origin with an active, not-yet-refilled bucket is never reaped, however many other calls tick the sweep', () => {
    const clock = fakeClock()
    const limiter = createTokenBucketLimiter({ capacity: 5, refillPerSecond: 1, now: clock.now })
    limiter.tryConsume(APP) // 4 of 5 tokens left -- short of full capacity
    clock.advance(500) // half a token's worth refills; still short of capacity

    limiter.tryConsume(OTHER) // ticks the sweep

    expect(limiter.size()).toBe(2) // APP's still-partial bucket survives alongside OTHER's
  })
})
