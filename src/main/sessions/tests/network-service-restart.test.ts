import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NetworkServiceRestart, isNetworkServiceEnd } from '../network-service-restart.js'
import type { HoldReport } from '../network-service-restart.js'

const BOUND_MS = 5000

function restartWithClock (): { restart: NetworkServiceRestart, reports: HoldReport[] } {
  const reports: HoldReport[] = []
  const restart = new NetworkServiceRestart({ now: Date.now, boundMs: BOUND_MS, ended: (report) => { reports.push(report) } })
  return { restart, reports }
}

/** Whether `promise` has settled, without waiting for it. */
async function settled (promise: Promise<unknown>): Promise<boolean> {
  let done = false
  void promise.then(() => { done = true })
  await vi.advanceTimersByTimeAsync(0)
  return done
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('a request while the network service is up', () => {
  it('goes on at once', async () => {
    const { restart } = restartWithClock()
    expect(restart.isHolding()).toBe(false)
    expect(await settled(restart.whenOpen())).toBe(true)
  })
})

describe('a request after the network service ended', () => {
  it('waits until the settings are sent again, then goes on', async () => {
    const { restart, reports } = restartWithClock()
    const generation = restart.gone()
    const waiting = restart.whenOpen()
    expect(restart.isHolding()).toBe(true)
    expect(await settled(waiting)).toBe(false)
    await vi.advanceTimersByTimeAsync(300)
    expect(restart.reapplied(generation)).toBe(true)
    expect(await settled(waiting)).toBe(true)
    expect(restart.isHolding()).toBe(false)
    expect(reports).toEqual([{ outcome: 'reapplied', heldMs: 300, requests: 1 }])
  })

  it('releases every request that waited, and counts them', async () => {
    const { restart, reports } = restartWithClock()
    const generation = restart.gone()
    const all = [restart.whenOpen(), restart.whenOpen(), restart.whenOpen()]
    restart.reapplied(generation)
    await Promise.all(all)
    expect(reports[0]?.requests).toBe(3)
  })

  it('is let go at the bound when the settings are never sent, and says so', async () => {
    const { restart, reports } = restartWithClock()
    restart.gone()
    const waiting = restart.whenOpen()
    await vi.advanceTimersByTimeAsync(BOUND_MS - 1)
    expect(await settled(waiting)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await settled(waiting)).toBe(true)
    expect(restart.isHolding()).toBe(false)
    expect(reports).toEqual([{ outcome: 'timed-out', heldMs: BOUND_MS, requests: 1 }])
    expect(restart.counts()).toEqual({ restarts: 1, timedOut: 1 })
  })

  it('goes on at once once the hold has ended', async () => {
    const { restart } = restartWithClock()
    const generation = restart.gone()
    restart.reapplied(generation)
    expect(await settled(restart.whenOpen())).toBe(true)
  })
})

describe('a second end during a hold', () => {
  it('keeps the requests waiting until the settings are sent for the later one', async () => {
    const { restart, reports } = restartWithClock()
    const first = restart.gone()
    const waiting = restart.whenOpen()
    await vi.advanceTimersByTimeAsync(100)
    const second = restart.gone()
    expect(restart.reapplied(first)).toBe(false)
    expect(restart.isHolding()).toBe(true)
    expect(await settled(waiting)).toBe(false)
    expect(restart.reapplied(second)).toBe(true)
    expect(await settled(waiting)).toBe(true)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ outcome: 'reapplied', heldMs: 100, requests: 1 })
    expect(restart.counts()).toEqual({ restarts: 2, timedOut: 0 })
  })

  it('starts the bound again from the later end', async () => {
    const { restart, reports } = restartWithClock()
    restart.gone()
    await vi.advanceTimersByTimeAsync(BOUND_MS - 100)
    restart.gone()
    await vi.advanceTimersByTimeAsync(BOUND_MS - 1)
    expect(reports).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(reports).toHaveLength(1)
    expect(reports[0]?.outcome).toBe('timed-out')
  })
})

describe('the settings sent after the bound', () => {
  it('end nothing a second time', async () => {
    const { restart, reports } = restartWithClock()
    const generation = restart.gone()
    await vi.advanceTimersByTimeAsync(BOUND_MS)
    expect(restart.reapplied(generation)).toBe(true)
    expect(reports).toHaveLength(1)
  })
})

describe('isNetworkServiceEnd', () => {
  it('is true for the utility process Chromium names as the network service', () => {
    expect(isNetworkServiceEnd({ type: 'Utility', serviceName: 'network.mojom.NetworkService' })).toBe(true)
  })

  it('is false for any other process', () => {
    expect(isNetworkServiceEnd({ type: 'Utility', serviceName: 'audio.mojom.AudioService' })).toBe(false)
    expect(isNetworkServiceEnd({ type: 'Utility' })).toBe(false)
    expect(isNetworkServiceEnd({ type: 'GPU', serviceName: 'network.mojom.NetworkService' })).toBe(false)
  })
})
