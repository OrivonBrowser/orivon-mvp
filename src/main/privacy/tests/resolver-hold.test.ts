import { afterEach, describe, expect, it, vi } from 'vitest'
import { holdResolver, onResolverHold, resolverHeld } from '../resolver-hold.js'

afterEach(() => { holdResolver(false) })

describe('the resolver hold', () => {
  it('is off until something holds it, and tells its listeners of a change only', () => {
    const heard = vi.fn()
    const stop = onResolverHold(heard)
    expect(resolverHeld()).toBe(false)
    holdResolver(false)
    expect(heard).not.toHaveBeenCalled()
    holdResolver(true)
    holdResolver(true)
    expect(resolverHeld()).toBe(true)
    expect(heard).toHaveBeenCalledTimes(1)
    holdResolver(false)
    expect(heard).toHaveBeenCalledTimes(2)
    stop()
    holdResolver(true)
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it('goes on telling the others when one listener throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const heard = vi.fn()
    const first = onResolverHold(() => { throw new Error('no') })
    const second = onResolverHold(heard)
    holdResolver(true)
    expect(heard).toHaveBeenCalledTimes(1)
    first()
    second()
    error.mockRestore()
  })
})
