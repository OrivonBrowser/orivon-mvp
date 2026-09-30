import { describe, expect, it } from 'vitest'
import { guardedSync } from '../sync-orivon.js'

describe('guardedSync and a rate-limited call', () => {
  it('asks again, with a growing pause, until the call is admitted', () => {
    const pauses: number[] = []
    let refused = 3
    const result = guardedSync(() => {
      if (refused-- > 0) throw Object.assign(new Error('this origin is calling too frequently; wait and retry'), { code: 'limit' })
      return 'read'
    }, (ms) => { pauses.push(ms) })
    expect(result).toBe('read')
    expect(pauses).toEqual([25, 50, 75])
  })

  it('gives up with the Node-shaped error after a bounded number of attempts', () => {
    let calls = 0
    expect(() => guardedSync(() => {
      calls += 1
      throw Object.assign(new Error('too frequently'), { code: 'limit' })
    }, () => undefined)).toThrow()
    expect(calls).toBe(41)
  })

  it('does not retry any other failure', () => {
    let calls = 0
    expect(() => guardedSync(() => {
      calls += 1
      throw Object.assign(new Error('no such file'), { code: 'not-found' })
    }, () => undefined)).toThrow()
    expect(calls).toBe(1)
  })
})
