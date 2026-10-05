import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindShareRegistry } from '../../bindings.js'
import type { ShareRegistry } from '../../types.js'
import { onShareChange, shareRegistryRebound } from '../share-events.js'

function registry (): ShareRegistry & { fire: () => void } {
  const listeners = new Set<() => void>()
  return {
    list: () => [], forRequester: () => [], forCaptured: () => [], stop: () => {},
    onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    fire: () => { for (const listener of [...listeners]) listener() }
  }
}

afterEach(() => { bindShareRegistry(undefined); shareRegistryRebound() })

describe('onShareChange', () => {
  it('calls a listener when the bound registry changes, and not after its removal', () => {
    const bound = registry()
    bindShareRegistry(bound)
    shareRegistryRebound()
    const listener = vi.fn()
    const off = onShareChange(listener)
    bound.fire()
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    bound.fire()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('follows a registry bound later, and tells the listeners to read again', () => {
    const listener = vi.fn()
    const off = onShareChange(listener)
    const later = registry()
    bindShareRegistry(later)
    shareRegistryRebound()
    expect(listener).toHaveBeenCalledTimes(1)
    later.fire()
    expect(listener).toHaveBeenCalledTimes(2)
    off()
  })

  it('keeps the other listeners going when one throws', () => {
    const bound = registry()
    bindShareRegistry(bound)
    shareRegistryRebound()
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const second = vi.fn()
    const offA = onShareChange(() => { throw new Error('boom') })
    const offB = onShareChange(second)
    bound.fire()
    expect(second).toHaveBeenCalled()
    offA(); offB(); quiet.mockRestore()
  })
})
