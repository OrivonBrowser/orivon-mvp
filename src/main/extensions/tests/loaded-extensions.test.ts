import { describe, expect, it, vi } from 'vitest'
import { createLoadedExtensions } from '../loaded-extensions.js'

function fakeSession (): { session: Parameters<typeof createLoadedExtensions>[0], loaded: unknown[], emit: (event: string) => void, listeners: Map<string, Set<() => void>> } {
  const loaded: unknown[] = []
  const listeners = new Map<string, Set<() => void>>()
  const extensions = {
    getAllExtensions: () => loaded,
    on: (event: string, listener: () => void) => { (listeners.get(event) ?? listeners.set(event, new Set()).get(event))?.add(listener) },
    off: (event: string, listener: () => void) => { listeners.get(event)?.delete(listener) }
  }
  return { session: { extensions } as never, loaded, listeners, emit: (event) => { for (const listener of listeners.get(event) ?? []) listener() } }
}

describe('createLoadedExtensions', () => {
  it('counts what the session has loaded now', () => {
    const { session, loaded } = fakeSession()
    const source = createLoadedExtensions(session)
    expect(source.count()).toBe(0)
    loaded.push({}, {})
    expect(source.count()).toBe(2)
  })

  it('tells a listener when an extension loads or unloads, until it is removed', () => {
    const { session, emit, listeners } = fakeSession()
    const listener = vi.fn()
    const stop = createLoadedExtensions(session).onChange(listener)
    emit('extension-loaded')
    emit('extension-unloaded')
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
    emit('extension-loaded')
    expect(listener).toHaveBeenCalledTimes(2)
    expect([...listeners.values()].every((set) => set.size === 0)).toBe(true)
  })
})
