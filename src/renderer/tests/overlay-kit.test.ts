import { describe, expect, it, vi } from 'vitest'
import { createOverlay, mountPage, shownPayload } from '../overlay/kit.js'
import type { Overlay, OverlayBridge, OverlayPage } from '../overlay/kit.js'

const root = { id: 'root' } as unknown as HTMLElement
const overlay = { name: 'demo', platform: 'linux' } as Overlay

function quiet (): void { vi.spyOn(console, 'error').mockImplementation(() => {}) }

describe('mountPage: a page that fails leaves an error state, never a blank overlay', () => {
  it('shows the error state when mount throws, and ignores every later show', () => {
    quiet()
    const showError = vi.fn()
    const mounted = mountPage({ mount: () => { throw new Error('boom') } }, root, overlay, showError)
    expect(showError).toHaveBeenCalledWith(root)
    expect(() => { mounted.shown(1) }).not.toThrow()
    expect(showError).toHaveBeenCalledTimes(1)
  })

  it('shows the error state when a later show throws, then stops calling the page', () => {
    quiet()
    const shown = vi.fn(() => { throw new Error('bad payload') })
    const showError = vi.fn()
    const mounted = mountPage({ mount: () => ({ shown }) }, root, overlay, showError)
    mounted.shown('a')
    mounted.shown('b')
    expect(showError).toHaveBeenCalledTimes(1)
    expect(shown).toHaveBeenCalledTimes(1)
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
