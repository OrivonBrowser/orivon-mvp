import { describe, expect, it } from 'vitest'
import { refusingProxy } from '../unimplemented.js'
import { OrivonShimError, refuseShim } from '../errors.js'

describe('refusingProxy, reused from src/shim-electron/ with this package\'s own error type', () => {
  it('serves every property already on the wrapped object unchanged', () => {
    const wrapped = refusingProxy({ known: () => 'ok' }, (prop) => refuseShim(prop, 'unimplemented', prop))
    expect(wrapped.known()).toBe('ok')
  })

  it('throws an OrivonShimError -- not shim-electron\'s ElectronShimError -- for a property not on the wrapped object', () => {
    const wrapped = refusingProxy({}, (prop) => refuseShim(`x.${prop}`, 'unimplemented', `no x.${prop}`)) as Record<string, unknown>
    expect(() => wrapped.missing).toThrow(OrivonShimError)
    try {
      void wrapped.missing
    } catch (error) {
      expect((error as OrivonShimError).api).toBe('x.missing')
      expect((error as OrivonShimError).reason).toBe('unimplemented')
    }
  })

  it('lets the `in` operator report an absent member truthfully, so real feature-detection is not fooled', () => {
    const wrapped = refusingProxy({}, (prop) => refuseShim(prop, 'unimplemented', prop))
    expect('missing' in wrapped).toBe(false)
  })
})
