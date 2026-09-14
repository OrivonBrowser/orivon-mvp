import { describe, expect, it } from 'vitest'
import { OrivonShimError, refuseShim } from '../errors.js'

describe('refuseShim / OrivonShimError', () => {
  it('builds (does not throw) an OrivonShimError carrying api, reason and a prefixed message', () => {
    const error = refuseShim('dns.resolve4', 'not-built', 'DNS needs its own broker capability')
    expect(error).toBeInstanceOf(OrivonShimError)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('OrivonShimError')
    expect(error.api).toBe('dns.resolve4')
    expect(error.reason).toBe('not-built')
    expect(error.message).toBe('orivon-node-shim: DNS needs its own broker capability')
  })

  it.each(['unimplemented', 'not-built', 'excluded', 'not-applicable'] as const)(
    'accepts %s as a reason',
    (reason) => {
      const error = refuseShim('x.y', reason, 'why')
      expect(error.reason).toBe(reason)
    }
  )
})
