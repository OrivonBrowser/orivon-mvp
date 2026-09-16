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

  it('does not throw reading a property not on the wrapped object -- A169: only calling it does', () => {
    const wrapped = refusingProxy({}, (prop) => notConsidered(`x.${prop}`)) as Record<string, unknown>
    expect(() => wrapped.missing).not.toThrow()
    expect('missing' in wrapped).toBe(false)
  })

  it('throws the classified error, not a bare TypeError, when a property not on the wrapped object is called', () => {
    const wrapped = refusingProxy({}, (prop) => notConsidered(`x.${prop}`)) as unknown as Record<string, () => unknown>
    expect(() => wrapped.missing!()).toThrow(ElectronShimError)
    try {
      wrapped.missing!()
    } catch (error) {
      expect((error as Error).name).not.toBe('TypeError')
      expect((error as ElectronShimError).api).toBe('x.missing')
    }
  })

  it('lets a symbol property fall through instead of throwing', () => {
    const wrapped = refusingProxy({}, () => notConsidered('x')) as Record<symbol, unknown>
    expect(wrapped[Symbol.iterator]).toBeUndefined()
  })

  // A135: src/shim/ reuses this exact function for its own Node-stdlib
  // refusals, with its own error class and reason union -- `classify` must
  // not be hardwired to ElectronShimReason/refuse(). Proven here with a
  // plain TypeError rather than any ElectronShimError, so a passing test
  // cannot be satisfied by classify secretly still routing through refuse().
  it('throws exactly what classify returns, not an ElectronShimError manufactured from it', () => {
    const wrapped = refusingProxy({}, (prop) => new TypeError(`unrelated: ${prop}`)) as unknown as Record<string, () => unknown>
    expect(() => wrapped.missing!()).toThrow(TypeError)
    try {
      wrapped.missing!()
    } catch (error) {
      expect(error).not.toBeInstanceOf(ElectronShimError)
      expect((error as Error).message).toBe('unrelated: missing')
    }
  })
})

describe('unimplementedMember', () => {
  it.each(['openExternal', 'showItemInFolder', 'trashItem'])(
    'shell.%s: reading it is safe (A169), calling it throws naming the member and the property together, reason unimplemented',
    (method) => {
      const shell = unimplementedMember('shell') as unknown as Record<string, () => unknown>
      expect(() => shell[method]).not.toThrow()
      expect(() => shell[method]!()).toThrow(ElectronShimError)
      try {
        shell[method]!()
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

  it('reading a name entirely outside the known surface is safe; calling it throws, not just outside a curated list', () => {
    const wrapped = withUnimplementedFallback({ app: 'real' }) as unknown as Record<string, () => unknown>
    expect(() => wrapped.somethingThisPackageHasNeverHeardOf).not.toThrow()
    expect(() => wrapped.somethingThisPackageHasNeverHeardOf!()).toThrow(ElectronShimError)
  })
})
