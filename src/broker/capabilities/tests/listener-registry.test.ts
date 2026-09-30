import { describe, expect, it, vi } from 'vitest'
import { createListenerRegistry } from '../listener-registry.js'

const APP = 'https://app.example'

describe('createListenerRegistry', () => {
  it('holds a port from add until its forget, per origin', () => {
    const registry = createListenerRegistry()
    const forget = registry.add(APP, 9000)
    expect(registry.holds(APP, 9000)).toBe(true)
    expect(registry.holds('https://other.example', 9000)).toBe(false)
    forget()
    expect(registry.holds(APP, 9000)).toBe(false)
  })

  it('tells a subscriber the origin and port when the last listener on it is forgotten', () => {
    const registry = createListenerRegistry()
    const heard = vi.fn()
    registry.onLastForgotten(heard)
    registry.add(APP, 9000)()
    expect(heard).toHaveBeenCalledExactlyOnceWith(APP, 9000)
  })

  it('tells nobody while another listener still holds the same port, and tells once it too is gone', () => {
    const registry = createListenerRegistry()
    const heard = vi.fn()
    registry.onLastForgotten(heard)
    const first = registry.add(APP, 9000)
    const second = registry.add(APP, 9000)
    first()
    expect(heard).not.toHaveBeenCalled()
    second()
    expect(heard).toHaveBeenCalledExactlyOnceWith(APP, 9000)
  })

  it('tells once for a forget called twice', () => {
    const registry = createListenerRegistry()
    const heard = vi.fn()
    registry.onLastForgotten(heard)
    const forget = registry.add(APP, 9000)
    forget()
    forget()
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('tells about the port that closed, not the ones still held', () => {
    const registry = createListenerRegistry()
    const heard = vi.fn()
    registry.onLastForgotten(heard)
    registry.add(APP, 9001)
    registry.add(APP, 9000)()
    expect(heard).toHaveBeenCalledExactlyOnceWith(APP, 9000)
    expect(registry.holds(APP, 9001)).toBe(true)
  })

  it('stops telling a subscriber that unsubscribed, and a subscriber that throws does not stop the forget or the others', () => {
    const registry = createListenerRegistry()
    const gone = vi.fn()
    const kept = vi.fn()
    registry.onLastForgotten(gone)()
    registry.onLastForgotten(() => { throw new Error('boom') })
    registry.onLastForgotten(kept)
    registry.add(APP, 9000)()
    expect(gone).not.toHaveBeenCalled()
    expect(kept).toHaveBeenCalledTimes(1)
    expect(registry.holds(APP, 9000)).toBe(false)
  })
})
