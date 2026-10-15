import { describe, expect, it } from 'vitest'
import { DIRECT_ROUTE, DIRECT_STALL_MS, REFERENCE_ROUND_TRIP_MS, RouteMeter, TUNNEL_PROFILE, ceilingWait } from '../route-pace.js'
import type { RouteProfile } from '../route-pace.js'

const SLOWER: RouteProfile = { id: 'later', roundTripMs: 10 * REFERENCE_ROUND_TRIP_MS, coldStartMs: 0, bytesPerSecond: 5_000 }

describe('the direct route', () => {
  it('leaves every wait as it was written', () => {
    expect(DIRECT_ROUTE.wait(25_000)).toBe(25_000)
    expect(DIRECT_ROUTE.firstWait(25_000)).toBe(25_000)
    expect(DIRECT_ROUTE.stallMs()).toBe(DIRECT_STALL_MS)
    expect(DIRECT_ROUTE.slow()).toBe(false)
  })
})

describe('a route with a declared profile', () => {
  it('stretches a wait by how much slower its round trip is than a direct one, so a new route declares numbers and no waits', () => {
    const route = new RouteMeter(SLOWER)
    expect(route.wait(10_000)).toBe(100_000)
    expect(route.stallMs()).toBe(DIRECT_STALL_MS * 10)
    expect(route.slow()).toBe(true)
  })

  it('adds the time a route may need to come up only until it has carried a request', () => {
    const route = new RouteMeter(TUNNEL_PROFILE)
    const cold = route.firstWait(10_000)
    expect(cold).toBe(route.wait(10_000) + TUNNEL_PROFILE.coldStartMs)
    route.markUp()
    expect(route.firstWait(10_000)).toBe(route.wait(10_000))
  })

  it('never goes under the floor it declared, and a fast route is not stretched', () => {
    const fast = new RouteMeter({ id: 'quick', roundTripMs: 50, coldStartMs: 0, bytesPerSecond: 1e9 })
    expect(fast.wait(10_000)).toBe(10_000)
    expect(fast.slow()).toBe(false)
  })

  it('gives a body the time its size needs at the route\'s rate, several times over', () => {
    const route = new RouteMeter(SLOWER)
    route.markUp()
    expect(route.transferMs(100_000)).toBeGreaterThanOrEqual(100_000 / SLOWER.bytesPerSecond * 1000)
    expect(route.transferMs(100_000)).toBeGreaterThan(route.transferMs(1_000))
    expect(DIRECT_ROUTE.transferMs(2_000_000)).toBeGreaterThan(DIRECT_ROUTE.transferMs(1_000))
  })
})

describe('a route that proves slower than it declared', () => {
  it('waits longer after a first byte that took long, up to three times its floor, and settles back as the evidence ages', () => {
    let now = 0
    const route = new RouteMeter(TUNNEL_PROFILE, () => now)
    const floor = route.wait(30_000)
    route.observeFirstByte(120_000)
    expect(route.wait(30_000)).toBeGreaterThan(floor)
    route.observeFirstByte(100 * 60_000)
    expect(route.wait(30_000)).toBe(floor * 3)
    now += 11 * 60_000
    expect(route.wait(30_000)).toBe(floor)
  })

  it('does not wait less because requests came back quickly', () => {
    const route = new RouteMeter(TUNNEL_PROFILE)
    const floor = route.wait(30_000)
    route.observeFirstByte(10)
    expect(route.wait(30_000)).toBe(floor)
  })

  it('treats the first byte as proof that the route is up', () => {
    const route = new RouteMeter(TUNNEL_PROFILE)
    route.observeFirstByte(1_000)
    expect(route.firstWait(10_000)).toBe(route.wait(10_000))
  })
})

describe('ceilingWait', () => {
  it('is never under what a meter of the same profile can wait, cold or not', () => {
    const route = new RouteMeter(TUNNEL_PROFILE)
    for (let i = 0; i < 40; i++) route.observeFirstByte(60 * 60_000)
    expect(ceilingWait(TUNNEL_PROFILE, 25_000)).toBeGreaterThanOrEqual(route.firstWait(25_000))
    expect(ceilingWait(TUNNEL_PROFILE, 25_000)).toBeGreaterThanOrEqual(new RouteMeter(TUNNEL_PROFILE).firstWait(25_000))
  })
})
