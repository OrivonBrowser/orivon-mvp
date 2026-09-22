import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReachSlotPool, REACH_SLOT_MAX_WAITERS, REACH_SLOT_WAIT_MS } from '../serve-reach-slots.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

/** Settles `reserved` if it already has, or reports 'pending' -- without advancing any timer. */
async function peek (reserved: boolean | Promise<boolean>): Promise<boolean | 'pending'> {
  return await Promise.race([Promise.resolve(reserved), Promise.resolve().then(() => 'pending' as const)])
}

describe('createReachSlotPool', () => {
  it('reserves synchronously while a slot is free', () => {
    const pool = createReachSlotPool(() => 2)
    expect(pool.reserve()).toBe(true)
    expect(pool.reserve()).toBe(true)
  })

  it('queues a request over the allowance instead of refusing it, and hands it the next released slot', async () => {
    const pool = createReachSlotPool(() => 1)
    expect(pool.reserve()).toBe(true)
    const queued = pool.reserve()
    expect(await peek(queued)).toBe('pending')

    pool.release()
    expect(await queued).toBe(true)
  })

  it('serves waiters first in, first out, and a newcomer never jumps the queue', async () => {
    const pool = createReachSlotPool(() => 1)
    pool.reserve()
    const order: string[] = []
    const first = Promise.resolve(pool.reserve()).then((granted) => { order.push(`first:${String(granted)}`) })
    const second = Promise.resolve(pool.reserve()).then((granted) => { order.push(`second:${String(granted)}`) })

    pool.release()
    await first
    // A slot is held by `first` now; a fresh caller must wait behind `second`.
    const late = pool.reserve()
    expect(await peek(late)).toBe('pending')

    pool.release()
    await second
    expect(order).toEqual(['first:true', 'second:true'])
    expect(await peek(late)).toBe('pending')
  })

  it('gives up after REACH_SLOT_WAIT_MS and frees the queue position', async () => {
    const pool = createReachSlotPool(() => 1)
    pool.reserve()
    const queued = pool.reserve()
    await vi.advanceTimersByTimeAsync(REACH_SLOT_WAIT_MS)
    expect(await queued).toBe(false)

    // The timed-out waiter must not swallow the next released slot.
    const next = pool.reserve()
    pool.release()
    expect(await next).toBe(true)
  })

  it('refuses at once when REACH_SLOT_MAX_WAITERS are already waiting -- the queue is bounded', () => {
    const pool = createReachSlotPool(() => 1)
    pool.reserve()
    for (let i = 0; i < REACH_SLOT_MAX_WAITERS; i++) pool.reserve()
    expect(pool.reserve()).toBe(false)
  })

  it('an aborted request leaves the queue and never takes a slot', async () => {
    const pool = createReachSlotPool(() => 1)
    pool.reserve()
    const controller = new AbortController()
    const aborted = pool.reserve(controller.signal)
    const behind = pool.reserve()
    controller.abort()
    expect(await aborted).toBe(false)

    pool.release()
    expect(await behind).toBe(true)
  })

  it('reads the allowance live, so a wider allowance admits queued requests on the next release', async () => {
    let limit = 1
    const pool = createReachSlotPool(() => limit)
    pool.reserve()
    const a = pool.reserve()
    const b = pool.reserve()
    limit = 3
    pool.release()
    expect(await a).toBe(true)
    expect(await b).toBe(true)
  })

  it('never lets the count go negative on a mismatched release', () => {
    const pool = createReachSlotPool(() => 1)
    pool.release()
    expect(pool.reserve()).toBe(true)
    expect(pool.reserve()).not.toBe(true)
  })
})
