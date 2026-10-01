import { describe, expect, it, vi } from 'vitest'
import { createOverlay, mountPage, readyEvents, shownPayload } from '../overlay/kit.js'
import type { Overlay, OverlayBridge, OverlayPage } from '../overlay/kit.js'

const root = { id: 'root', replaceChildren: vi.fn() } as unknown as HTMLElement
const overlay = { name: 'demo', platform: 'linux' } as Overlay

function quiet (): void { vi.spyOn(console, 'error').mockImplementation(() => {}) }

describe('mountPage: a page that fails leaves an error state, never a blank overlay', () => {
  it('shows the error state when mount throws, and builds the page again on the next show', () => {
    quiet()
    const showError = vi.fn()
    const shown = vi.fn()
    let attempts = 0
    const mount = vi.fn(() => {
      attempts += 1
      if (attempts === 1) throw new Error('boom')
      return { shown }
    })
    const mounted = mountPage({ mount }, root, overlay, showError)
    expect(showError).toHaveBeenCalledWith(root)
    mounted.shown(1)
    expect(mount).toHaveBeenCalledTimes(2)
    expect(shown).toHaveBeenCalledWith(1)
    expect(showError).toHaveBeenCalledTimes(1)
  })

  it('clears the error state from the root before the page is built again', () => {
    quiet()
    const order: string[] = []
    const fakeRoot = { replaceChildren: () => { order.push('clear') } } as unknown as HTMLElement
    let attempts = 0
    const mounted = mountPage({ mount: () => { order.push('mount'); attempts += 1; if (attempts === 1) throw new Error('boom'); return { shown: () => {} } } }, fakeRoot, overlay, () => { order.push('error') })
    mounted.shown(1)
    expect(order).toEqual(['mount', 'error', 'clear', 'mount'])
  })

  it('keeps showing the error state while the page keeps failing, one failure per show', () => {
    quiet()
    const showError = vi.fn()
    const mounted = mountPage({ mount: () => { throw new Error('boom') } }, root, overlay, showError)
    expect(() => { mounted.shown(1) }).not.toThrow()
    expect(() => { mounted.shown(2) }).not.toThrow()
    expect(showError).toHaveBeenCalledTimes(3)
  })

  it('shows the error state when a show throws, and the next show builds the page again', () => {
    quiet()
    const showError = vi.fn()
    let built = 0
    const shown = vi.fn((payload: unknown) => { if (payload === 'bad') throw new Error('bad payload') })
    const mount = vi.fn(() => { built += 1; return { shown } })
    const mounted = mountPage({ mount }, root, overlay, showError)
    mounted.shown('bad')
    expect(showError).toHaveBeenCalledTimes(1)
    mounted.shown('good')
    expect(built).toBe(2)
    expect(shown).toHaveBeenLastCalledWith('good')
    expect(showError).toHaveBeenCalledTimes(1)
  })

  it('shows the error state for an overlay with no registered page', () => {
    quiet()
    const showError = vi.fn()
    mountPage(undefined, root, overlay, showError)
    expect(showError).toHaveBeenCalledWith(root)
  })

  it('survives an error state that fails as well', () => {
    quiet()
    expect(() => mountPage(undefined, root, overlay, () => { throw new Error('dom gone') })).not.toThrow()
  })

  it('passes a healthy page its root and overlay and every payload', () => {
    const shown = vi.fn()
    const mount = vi.fn(() => ({ shown }))
    const showError = vi.fn()
    const mounted = mountPage({ mount } as OverlayPage, root, overlay, showError)
    mounted.shown({ a: 1 })
    expect(mount).toHaveBeenCalledWith(root, overlay)
    expect(shown).toHaveBeenCalledWith({ a: 1 })
    expect(showError).not.toHaveBeenCalled()
  })

  it('one failing page does not touch another page mounted in its own root', () => {
    quiet()
    const showError = vi.fn()
    const good = vi.fn()
    mountPage({ mount: () => { throw new Error('x') } }, root, overlay, showError)
    const other = mountPage({ mount: () => ({ shown: good }) }, root, overlay, showError)
    other.shown(1)
    expect(good).toHaveBeenCalledWith(1)
  })
})

describe('createOverlay', () => {
  function bridge (): { bridge: OverlayBridge, emit: (message: unknown) => void, close: ReturnType<typeof vi.fn> } {
    const listeners = new Set<(message: unknown) => void>()
    const close = vi.fn()
    return {
      close,
      bridge: {
        name: 'demo', platform: 'linux',
        ready: async () => undefined, request: async (command: unknown) => ({ echoed: command }), size: () => {}, close: (reason) => { close(reason) },
        onEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }
      },
      emit: (message) => { for (const listener of listeners) listener(message) }
    }
  }

  it('carries the name and platform, and forwards requests', async () => {
    const b = bridge()
    const o = createOverlay(b.bridge)
    expect([o.name, o.platform]).toEqual(['demo', 'linux'])
    await expect(o.request({ id: 1 })).resolves.toEqual({ echoed: { id: 1 } })
  })

  it('delivers only event messages, unwrapped, and unsubscribes', () => {
    const b = bridge()
    const listener = vi.fn()
    const off = createOverlay(b.bridge).onEvent(listener)
    b.emit({ type: 'show', payload: 1 })
    b.emit('nonsense')
    b.emit({ type: 'event', event: { n: 2 } })
    expect(listener.mock.calls).toEqual([[{ n: 2 }]])
    off()
    b.emit({ type: 'event', event: 3 })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('hands the events a ready reply carried to the page\'s listeners, in order, and not to one that unsubscribed', () => {
    const b = bridge()
    const kept = vi.fn(); const dropped = vi.fn()
    const o = createOverlay(b.bridge)
    o.onEvent(kept)
    o.onEvent(dropped)()
    o.replay(['first', 'second'])
    expect(kept.mock.calls).toEqual([['first'], ['second']])
    expect(dropped).not.toHaveBeenCalled()
  })

  it('reads the events of a ready reply, and none from any other shape', () => {
    expect(readyEvents({ shown: true, payload: 1, events: ['a', 2] })).toEqual(['a', 2])
    expect(readyEvents({ shown: false })).toEqual([])
    expect(readyEvents({ events: 'nope' })).toEqual([])
    expect(readyEvents(undefined)).toEqual([])
  })

  it('closes as a request', () => {
    const b = bridge()
    createOverlay(b.bridge).close()
    expect(b.close).toHaveBeenCalledWith('request')
  })
})

describe('shownPayload', () => {
  it('reads a show message and a ready reply, and nothing else', () => {
    expect(shownPayload({ type: 'show', payload: 5 }, 'show')).toEqual({ payload: 5 })
    expect(shownPayload({ type: 'event', event: 5 }, 'show')).toBeNull()
    expect(shownPayload({ shown: true, payload: 6 }, 'ready')).toEqual({ payload: 6 })
    expect(shownPayload({ shown: false }, 'ready')).toBeNull()
    expect(shownPayload(undefined, 'ready')).toBeNull()
    expect(shownPayload(null, 'show')).toBeNull()
  })
})
