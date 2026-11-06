import { describe, expect, it } from 'vitest'
import { DIRECT_ROUTE, RouteMeter, TUNNEL_PROFILE } from '../../route-pace.js'
import { lightClientPace, mountCeilingMs, paceOn, routeFor } from '../pace.js'

describe('the pace of the verifier host', () => {
  it('is the direct one with no tunnel, and a slower one through a tunnel', () => {
    expect(routeFor(false)).toBe(DIRECT_ROUTE)
    const tunnel = paceOn(routeFor(true))
    const direct = paceOn(DIRECT_ROUTE)
    expect(tunnel.syncWaitMs).toBeGreaterThan(direct.syncWaitMs)
    expect(tunnel.mountTimeoutMs).toBeGreaterThan(direct.mountTimeoutMs)
  })

  it('keeps each wait inside the one that holds it, so the inner step is the one that answers', () => {
    for (const pace of [paceOn(DIRECT_ROUTE), paceOn(new RouteMeter(TUNNEL_PROFILE))]) {
      expect(pace.syncWaitMs).toBeLessThan(pace.mountTimeoutMs)
      expect(pace.lightClientStartAfterMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('keeps the direct pace at a sync wait of 8 s, a proof of 45 s, a light client that starts at once, and execution servers hedged after 1 s and given up on after 10 s', () => {
    expect(paceOn(DIRECT_ROUTE)).toEqual({ syncWaitMs: 8_000, mountTimeoutMs: 45_000, lightClientStartAfterMs: 0, rpcHedgeMs: 1_000, rpcAttemptTimeoutMs: 10_000 })
  })

  it('stretches the waits on the execution servers for a tunnel, and keeps a request that hangs inside the proof that waits on it', () => {
    const direct = paceOn(DIRECT_ROUTE)
    const tunnel = paceOn(new RouteMeter(TUNNEL_PROFILE))
    expect(tunnel.rpcHedgeMs).toBeGreaterThan(direct.rpcHedgeMs)
    expect(tunnel.rpcAttemptTimeoutMs).toBeGreaterThan(direct.rpcAttemptTimeoutMs)
    for (const pace of [direct, tunnel]) {
      expect(pace.rpcHedgeMs).toBeLessThan(pace.rpcAttemptTimeoutMs)
      expect(pace.rpcAttemptTimeoutMs).toBeLessThan(pace.mountTimeoutMs)
    }
  })

  it('hands the light client its sync wait, its start delay and the two waits on the execution servers', () => {
    const pace = paceOn(new RouteMeter(TUNNEL_PROFILE))
    expect(lightClientPace(pace)).toEqual({ syncWaitMs: pace.syncWaitMs, startAfterMs: pace.lightClientStartAfterMs, rpcHedgeMs: pace.rpcHedgeMs, rpcAttemptTimeoutMs: pace.rpcAttemptTimeoutMs })
  })

  it('holds the light client back on a slow route, which would otherwise share it with a person\'s page', () => {
    expect(paceOn(new RouteMeter(TUNNEL_PROFILE)).lightClientStartAfterMs).toBe(3 * 60_000)
  })

  it('gives a tunnel more time while it is coming up than once it has carried a request', () => {
    const route = new RouteMeter(TUNNEL_PROFILE)
    const cold = paceOn(route).mountTimeoutMs
    route.markUp()
    expect(paceOn(route).mountTimeoutMs).toBeLessThan(cold)
  })

  it('never answers the shell later than the host would give up: the shell\'s ceiling covers a cold, fully widened tunnel', () => {
    const route = new RouteMeter(TUNNEL_PROFILE)
    for (let i = 0; i < 4; i++) route.observeFirstByte(10 * 60_000)
    expect(mountCeilingMs(true)).toBeGreaterThanOrEqual(paceOn(new RouteMeter(TUNNEL_PROFILE)).mountTimeoutMs)
    route.markUp()
    expect(mountCeilingMs(true)).toBeGreaterThanOrEqual(paceOn(route).mountTimeoutMs)
    expect(mountCeilingMs(false)).toBe(45_000)
  })
})
