import { describe, expect, it } from 'vitest'
import { refusingProxy } from '../unimplemented.js'
import { OrivonShimError, refuseShim } from '../errors.js'

describe('refusingProxy, reused from src/shim-electron/ with this package\'s own error type', () => {
  it('serves every property already on the wrapped object unchanged', () => {
    const wrapped = refusingProxy({ known: () => 'ok' }, (prop) => refuseShim(prop, 'unimplemented', prop))
    expect(wrapped.known()).toBe('ok')
  })

  it('lets the `in` operator report an absent member truthfully -- the one idiom that was never affected by A169, since `in` never goes through `get`', () => {
    const wrapped = refusingProxy({}, (prop) => refuseShim(prop, 'unimplemented', prop))
    expect('missing' in wrapped).toBe(false)
  })
})

// A169: #186 made `refusingProxy`'s `get` trap throw the instant an
// unimplemented member was READ, not just called -- so `typeof x.y ===
// 'function'`, `x?.y?.()` and `const { y } = x` (every idiom a ported
// library actually uses to feature-detect before calling) crashed instead
// of gracefully skipping the unsupported branch, same as real Node does for
// a member that genuinely does not exist. These prove the fix: a read is
// safe, and only an actual call still throws the named refusal.
describe('a read of an unimplemented member is safe; only a call still refuses by name (A169)', () => {
  function wrapped (): Record<string, unknown> {
    return refusingProxy({}, (prop) => refuseShim(`x.${prop}`, 'unimplemented', `no x.${prop}`)) as Record<string, unknown>
  }

  it('does not throw reading it, unlike before A169 -- and typeof reports the same "callable" answer real Node gives for a method it actually has, since a throwing function is still a function', () => {
    const w = wrapped()
    let read: unknown
    expect(() => { read = w.missing }).not.toThrow()
    expect(typeof read).toBe('function')
  })

  it('does not throw at the optional-chained read; only going on to invoke it does', () => {
    const w = wrapped() as { missing?: () => unknown }
    expect(() => w.missing).not.toThrow()
    expect(() => w.missing?.()).toThrow(OrivonShimError)
  })

  it('does not throw destructuring it', () => {
    const w = wrapped()
    expect(() => { const { missing } = w; void missing }).not.toThrow()
  })

  it('still reports it absent from `in`, exactly as before', () => {
    const w = wrapped()
    expect('missing' in w).toBe(false)
  })

  it('throws the named OrivonShimError -- not a bare "is not a function" -- when actually called', () => {
    const w = wrapped() as { missing: () => unknown }
    expect(() => w.missing()).toThrow(OrivonShimError)
    try {
      w.missing()
    } catch (error) {
      expect((error as OrivonShimError).api).toBe('x.missing')
      expect((error as OrivonShimError).reason).toBe('unimplemented')
    }
  })
})

// A library subclasses or type-checks a member it expects to be a class
// (`class Pool extends http.Agent`, `x instanceof net.BlockList`). An arrow
// function has no prototype, so each of those failed with a bare TypeError
// that named nothing.
describe('an unbuilt member behaves like a constructor that refuses by name', () => {
  function wrapped (): Record<string, new (...args: unknown[]) => object> {
    return refusingProxy({}, (prop) => refuseShim(`x.${prop}`, 'unimplemented', `no x.${prop}`)) as Record<string, new (...args: unknown[]) => object>
  }

  it('`new` throws the named refusal, not "is not a constructor"', () => {
    const W = wrapped().Missing!
    expect(() => new W()).toThrow(OrivonShimError)
  })

  it('`extends` succeeds at class definition and refuses by name at construction', () => {
    const Base = wrapped().Missing!
    class Derived extends Base {}
    expect(() => new Derived()).toThrow(OrivonShimError)
  })

  it('`instanceof` answers false instead of throwing', () => {
    const W = wrapped().Missing!
    expect({} instanceof W).toBe(false)
  })

  it('reads of the same member return the same function, so identity checks hold', () => {
    const w = wrapped()
    expect(w.Missing).toBe(w.Missing)
  })
})
