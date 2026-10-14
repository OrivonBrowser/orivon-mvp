import { describe, expect, it } from 'vitest'
import { DIRECT_PACE, paceOf, TUNNEL_PACE } from '../pace.js'

describe('the pace of the verifier host', () => {
  it('is the direct one with no tunnel, and a slower one through a tunnel', () => {
    expect(paceOf(false)).toBe(DIRECT_PACE)
    expect(paceOf(true)).toBe(TUNNEL_PACE)
    expect(TUNNEL_PACE.syncWaitMs).toBeGreaterThan(DIRECT_PACE.syncWaitMs)
    expect(TUNNEL_PACE.mountTimeoutMs).toBeGreaterThan(DIRECT_PACE.mountTimeoutMs)
  })

  it('keeps each wait inside the one that holds it, so the inner step is the one that answers', () => {
    for (const pace of [DIRECT_PACE, TUNNEL_PACE]) {
      expect(pace.syncWaitMs).toBeLessThan(pace.mountTimeoutMs)
      expect(pace.lightClientStartAfterMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('keeps the direct pace at a sync wait of 8 s, a proof of 25 s and a light client that starts at once', () => {
    expect(DIRECT_PACE.syncWaitMs).toBe(8_000)
    expect(DIRECT_PACE.mountTimeoutMs).toBe(25_000)
    expect(DIRECT_PACE.lightClientStartAfterMs).toBe(0)
  })
})
