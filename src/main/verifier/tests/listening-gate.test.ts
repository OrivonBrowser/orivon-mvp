import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ListeningGate } from '../listening-gate.js'

const BOUND_MS = 10_000

/** Whether `promise` has settled yet, after letting every already-due timer and microtask run. */
async function settled (promise: Promise<void>): Promise<boolean> {
  let done = false
  void promise.then(() => { done = true })
  await vi.advanceTimersByTimeAsync(0)
  return done
}

describe('ListeningGate', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('holds a request while the host has not started listening, and releases it when it does', async () => {
    const gate = new ListeningGate(BOUND_MS)
    const held = gate.whenSettled()
    expect(await settled(held)).toBe(false)
    gate.listening()
    expect(await settled(held)).toBe(true)
  })

  it('does not hold a request while the host is listening', async () => {
    const gate = new ListeningGate(BOUND_MS)
    gate.listening()
    expect(await settled(gate.whenSettled())).toBe(true)
  })

  it('releases a held request when the host reports it cannot serve, so it fails as it would without the gate', async () => {
    const gate = new ListeningGate(BOUND_MS)
    const held = gate.whenSettled()
    gate.down()
    expect(await settled(held)).toBe(true)
  })

  it('does not hold a request while the host is down', async () => {
    const gate = new ListeningGate(BOUND_MS)
    gate.down()
    expect(await settled(gate.whenSettled())).toBe(true)
  })

  it('releases a held request at the bound when the host says nothing', async () => {
    const gate = new ListeningGate(BOUND_MS)
    const held = gate.whenSettled()
    await vi.advanceTimersByTimeAsync(BOUND_MS - 1)
    expect(await settled(held)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await settled(held)).toBe(true)
  })

  it('holds requests again while a stopped host restarts', async () => {
    const gate = new ListeningGate(BOUND_MS)
    gate.listening()
    gate.down()
    gate.starting()
    const held = gate.whenSettled()
    expect(await settled(held)).toBe(false)
    gate.listening()
    expect(await settled(held)).toBe(true)
  })

  it('releases every held request at once, and leaves no timer behind', async () => {
    const gate = new ListeningGate(BOUND_MS)
    const held = [gate.whenSettled(), gate.whenSettled(), gate.whenSettled()]
    gate.listening()
    for (const request of held) expect(await settled(request)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
