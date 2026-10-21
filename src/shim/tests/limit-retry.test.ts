import { describe, expect, it } from 'vitest'
import { createCallQueue, retryLimited } from '../limit-retry.js'

const limited = (): Error => Object.assign(new Error('this origin is calling too frequently; wait and retry'), { code: 'limit' })

describe('retryLimited', () => {
  it('asks again, pausing longer each time, until the call is admitted', async () => {
    const pauses: number[] = []
    let refused = 3
    const result = await retryLimited(async () => { if (refused-- > 0) throw limited(); return 'opened' }, async (ms) => { pauses.push(ms) })
    expect(result).toBe('opened')
    expect(pauses).toEqual([10, 25, 50])
  })

  it('throws the refusal itself after thirteen retries', async () => {
    let calls = 0
    const error = limited()
    await expect(retryLimited(async () => { calls += 1; throw error }, async () => undefined)).rejects.toBe(error)
    expect(calls).toBe(14)
  })

  it('does not retry any other failure', async () => {
    let calls = 0
    await expect(retryLimited(async () => { calls += 1; throw Object.assign(new Error('refused'), { code: 'denied' }) }, async () => undefined)).rejects.toMatchObject({ code: 'denied' })
    expect(calls).toBe(1)
  })
})

describe('createCallQueue: fs calls wait for room where Node would queue them', () => {
  it('runs at most `max` at once, starts the rest in order, and refuses none', async () => {
    const queue = createCallQueue(2)
    let running = 0
    let peak = 0
    const started: number[] = []
    const releases: Array<() => void> = []
    const calls = [0, 1, 2, 3, 4].map(async (n) => await queue(async () => {
      started.push(n)
      running += 1
      peak = Math.max(peak, running)
      await new Promise<void>((resolve) => { releases.push(resolve) })
      running -= 1
      return n
    }))
    await Promise.resolve()
    expect(started).toEqual([0, 1])
    while (releases.length > 0) {
      releases.shift()!()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(await Promise.all(calls)).toEqual([0, 1, 2, 3, 4])
    expect(started).toEqual([0, 1, 2, 3, 4])
    expect(peak).toBe(2)
  })

  it('frees the place of a call that throws', async () => {
    const queue = createCallQueue(1)
    await expect(queue(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await queue(async () => 'next')).toBe('next')
  })
})
