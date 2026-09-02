import { describe, expect, it } from 'vitest'
import { createTokenBucketLimiter } from './token-bucket.js'

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
