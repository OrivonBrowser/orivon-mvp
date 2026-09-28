import { describe, expect, it } from 'vitest'
import { GatewayHealth, retryAfterMs } from '../gateway-health.js'

describe('retryAfterMs', () => {
  it('reads a delta-seconds value', () => {
    expect(retryAfterMs('120', 0)).toBe(120_000)
  })

  it('reads an HTTP-date value relative to now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(retryAfterMs('2026-01-01T00:00:05Z', now)).toBe(5_000)
  })

  it('never goes negative for a date already in the past', () => {
    const now = Date.parse('2026-01-01T00:00:05Z')
    expect(retryAfterMs('2026-01-01T00:00:00Z', now)).toBe(0)
  })

  it('is undefined for no header, or an unparseable one', () => {
    expect(retryAfterMs(null, 0)).toBeUndefined()
    expect(retryAfterMs('not a date or a number', 0)).toBeUndefined()
  })
})

function clock (start = 0): { now: () => number, set: (t: number) => void } {
  let time = start
  return { now: () => time, set: (t) => { time = t } }
}

describe('GatewayHealth', () => {
  it('starts not cooling', () => {
    const health = new GatewayHealth()
    expect(health.cooling()).toBe(false)
  })

  it('a miss changes nothing', () => {
    const health = new GatewayHealth()
    health.note({ kind: 'miss' })
    expect(health.cooling()).toBe(false)
  })

  it('a rate-limited outcome cools for its own Retry-After, capped', () => {
    const c = clock()
    const health = new GatewayHealth(c.now)
    health.note({ kind: 'rate-limited', retryAfterMs: 5_000 })
    expect(health.cooling()).toBe(true)
    expect(health.readyAt()).toBe(5_000)
    c.set(4_999)
    expect(health.cooling()).toBe(true)
    c.set(5_000)
    expect(health.cooling()).toBe(false)
  })

  it('caps an oversized Retry-After', () => {
    const c = clock()
    const health = new GatewayHealth(c.now)
    health.note({ kind: 'rate-limited', retryAfterMs: 10 * 60_000 })
    expect(health.readyAt()).toBe(15_000)
  })

  it('with no Retry-After, backs off from 1s, doubling on repeated 429s', () => {
    const c = clock()
    const health = new GatewayHealth(c.now)
    health.note({ kind: 'rate-limited', retryAfterMs: undefined })
    expect(health.readyAt()).toBe(1_000)
    c.set(1_000)
    health.note({ kind: 'rate-limited', retryAfterMs: undefined })
    expect(health.readyAt()).toBe(1_000 + 2_000)
    c.set(1_000 + 2_000)
    health.note({ kind: 'rate-limited', retryAfterMs: undefined })
    expect(health.readyAt()).toBe(1_000 + 2_000 + 4_000)
  })

  it('an unreachable outcome cools immediately, starting at 2s and doubling', () => {
    const c = clock()
    const health = new GatewayHealth(c.now)
    health.note({ kind: 'unreachable' })
    expect(health.readyAt()).toBe(2_000)
    c.set(2_000)
    health.note({ kind: 'unreachable' })
    expect(health.readyAt()).toBe(2_000 + 4_000)
  })

  it('caps unreachable backoff at 60s', () => {
    const c = clock()
    const health = new GatewayHealth(c.now)
    for (let i = 0; i < 10; i++) { health.note({ kind: 'unreachable' }); c.set(health.readyAt()) }
    const before = health.readyAt()
    health.note({ kind: 'unreachable' })
    expect(health.readyAt() - before).toBe(60_000)
  })

  it('a single timeout does not cool the gateway down', () => {
    const health = new GatewayHealth()
    health.note({ kind: 'timeout' })
    expect(health.cooling()).toBe(false)
  })

  it('two timeouts in a row, with no success between, do cool it down', () => {
    const c = clock()
    const health = new GatewayHealth(c.now)
    health.note({ kind: 'timeout' })
    health.note({ kind: 'timeout' })
    expect(health.cooling()).toBe(true)
    expect(health.readyAt()).toBe(2_000)
  })

  it('a success between two timeouts resets the timeout streak', () => {
    const health = new GatewayHealth()
    health.note({ kind: 'timeout' })
    health.note({ kind: 'ok' })
    health.note({ kind: 'timeout' })
    expect(health.cooling()).toBe(false)
  })

  it('ok resets the strike counters but never lifts a cooldown already running', () => {
    const c = clock()
    const health = new GatewayHealth(c.now)
    health.note({ kind: 'unreachable' })
    expect(health.cooling()).toBe(true)
    health.note({ kind: 'ok' })
    expect(health.cooling()).toBe(true)
    // The reset strike counters show up on the NEXT failure, starting over at the base delay.
    c.set(health.readyAt())
    const readyBefore = health.readyAt()
    health.note({ kind: 'unreachable' })
    expect(health.readyAt() - readyBefore).toBe(2_000)
  })
})
