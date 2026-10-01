import { afterEach, describe, expect, it } from 'vitest'
import { SYNCHRONOUS } from '../../worker/sync-channel.js'
import { guardedSync, retriedSync, tryStatSync } from '../sync-orivon.js'

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

describe('existsSync\'s probe and a rate-limited call', () => {
  const holder = globalThis as unknown as Record<string, unknown>
  afterEach(() => { Reflect.deleteProperty(holder, 'orivon') })

  function withStat (stat: () => void): void {
    holder['orivon'] = { [SYNCHRONOUS]: { fs: { stat } } }
  }

  it('answers true for a file the limiter refused twice before it admitted the stat', () => {
    let refused = 2
    withStat(() => { if (refused-- > 0) throw Object.assign(new Error('too frequently'), { code: 'limit' }) })
    expect(tryStatSync('/orivon/app/present')).toBe(true)
  })

  it('answers false for a file that is missing', () => {
    withStat(() => { throw Object.assign(new Error('missing'), { code: 'not-found' }) })
    expect(tryStatSync('/orivon/app/absent')).toBe(false)
  })
})

describe('retriedSync and a thread that may not block', () => {
  it('lets the refusal through when the pause cannot be made', () => {
    expect(() => guardedSync(() => { throw Object.assign(new Error('too frequently'), { code: 'limit' }) }, () => false)).toThrow()
  })

  it('returns the value once a refused call is admitted', () => {
    let refused = 1
    expect(retriedSync(() => { if (refused-- > 0) throw Object.assign(new Error('too frequently'), { code: 'limit' }); return 7 })).toBe(7)
  })
})
