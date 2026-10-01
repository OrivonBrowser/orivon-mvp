import { describe, expect, it } from 'vitest'
import { guarded } from '../paths.js'

const limited = (): Error => Object.assign(new Error('this origin is calling too frequently; wait and retry'), { code: 'limit' })

describe('guarded and a rate-limited call', () => {
  it('asks again, pausing longer each time, until the call is admitted', async () => {
    const pauses: number[] = []
    let refused = 3
    const result = await guarded(async () => {
      if (refused-- > 0) throw limited()
      return 'read'
    }, async (ms) => { pauses.push(ms) })
    expect(result).toBe('read')
    expect(pauses).toEqual([10, 25, 50])
  })

  it('gives up with the Node-shaped error after a bounded number of attempts', async () => {
    let calls = 0
    await expect(guarded(async () => { calls += 1; throw limited() }, async () => undefined)).rejects.toBeInstanceOf(Error)
    expect(calls).toBe(14)
  })

  it('does not retry any other failure', async () => {
    let calls = 0
    await expect(guarded(async () => { calls += 1; throw Object.assign(new Error('missing'), { code: 'not-found' }) }, async () => undefined)).rejects.toBeInstanceOf(Error)
    expect(calls).toBe(1)
  })
})
