import { describe, expect, it } from 'vitest'
import { ElectronShimError } from '../errors.js'
import { notConsidered, refusingProxy, unimplementedMember, withUnimplementedFallback } from '../unimplemented.js'

describe('notConsidered', () => {
  it('names the api, reasons it unimplemented, and says plainly that nothing has decided', () => {
    const refusal = notConsidered('shell.openExternal')
    expect(refusal.api).toBe('shell.openExternal')
    expect(refusal.reason).toBe('unimplemented')
    expect(refusal.message).toMatch(/shell\.openExternal/)
    expect(refusal.message).toMatch(/nothing has decided/i)
  })
})

describe('refusingProxy', () => {
  it('serves every property already on the wrapped object unchanged', () => {
    const wrapped = refusingProxy({ known: () => 'ok' }, (prop) => notConsidered(prop))
    expect(wrapped.known()).toBe('ok')
  })

  it('throws the classified error, not a bare TypeError, for a property not on the wrapped object', () => {
    const wrapped = refusingProxy({}, (prop) => notConsidered(`x.${prop}`)) as Record<string, unknown>
    expect(() => wrapped.missing).toThrow(ElectronShimError)
    try {
      void wrapped.missing
    } catch (error) {
      expect((error as Error).name).not.toBe('TypeError')
      expect((error as ElectronShimError).api).toBe('x.missing')
    }
  })

  it('lets a symbol property fall through instead of throwing', () => {
    const wrapped = refusingProxy({}, () => notConsidered('x')) as Record<symbol, unknown>
    expect(wrapped[Symbol.iterator]).toBeUndefined()
  })
})

describe('unimplementedMember', () => {
  it.each(['openExternal', 'showItemInFolder', 'trashItem'])(
    'shell.%s throws naming the member and the property together, reason unimplemented',
    (method) => {
      const shell = unimplementedMember('shell') as Record<string, unknown>
      expect(() => shell[method]).toThrow(ElectronShimError)
      try {
        void shell[method]
      } catch (error) {
        expect((error as ElectronShimError).api).toBe(`shell.${method}`)
        expect((error as ElectronShimError).reason).toBe('unimplemented')
      }
    }
  )
})

describe('withUnimplementedFallback', () => {
  it('serves a known property unchanged', () => {
    const wrapped = withUnimplementedFallback({ app: 'real' })
    expect(wrapped.app).toBe('real')
  })

  it('throws for a name entirely outside the known surface, not just outside a curated list', () => {
    const wrapped = withUnimplementedFallback({ app: 'real' }) as Record<string, unknown>
    expect(() => wrapped.somethingThisPackageHasNeverHeardOf).toThrow(ElectronShimError)
  })
})
