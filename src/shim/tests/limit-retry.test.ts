import { describe, expect, it } from 'vitest'
import { retryLimited } from '../limit-retry.js'

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
