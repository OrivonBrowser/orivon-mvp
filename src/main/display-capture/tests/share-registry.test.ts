import { describe, expect, it, vi } from 'vitest'
import { CAPTURE_POLL_MS, createShareRegistry, type ShareRegistryDeps } from '../share-registry.js'
import type { DisplayChoice } from '../types.js'

const requester = { id: 1 } as never
const shown = { id: 2 } as never

const SCREEN: DisplayChoice = { kind: 'screen', source: { id: 'screen:0:0', name: 'Entire screen' }, systemAudio: false, label: 'Entire screen' }
const TAB: DisplayChoice = { kind: 'tab', tab: shown, audio: true, label: 'A tab' }

function setup (): {
  registry: ReturnType<typeof createShareRegistry>
  deps: ShareRegistryDeps
  watchers: Map<unknown, Array<() => void>>
  capturing: Set<unknown>
  tick: () => void
  pollers: () => number
} {
  const watchers = new Map<unknown, Array<() => void>>()
  const capturing = new Set<unknown>()
  let counter = 0
  let polling: (() => void) | undefined
  let pollers = 0
  const deps: ShareRegistryDeps = {
    now: () => 42,
    newId: () => `share-${++counter}`,
    watch: (contents, ended) => {
      const list = watchers.get(contents) ?? []
      list.push(ended)
      watchers.set(contents, list)
      return () => { watchers.set(contents, (watchers.get(contents) ?? []).filter((fn) => fn !== ended)) }
    },
    isBeingCaptured: (contents) => capturing.has(contents),
    sendStop: vi.fn(),
    markInUse: vi.fn(),
    clearInUse: vi.fn(),
    every: (run, ms) => {
      expect(ms).toBe(CAPTURE_POLL_MS)
      polling = run
      pollers++
      return () => { polling = undefined; pollers-- }
    }
  }
  return { registry: createShareRegistry(deps), deps, watchers, capturing, tick: () => { polling?.() }, pollers: () => pollers }
}

describe('the share registry', () => {
  it('starts a share the indicators can find from its requester, and tells listeners', () => {
    const { registry, deps } = setup()
    const heard = vi.fn()
    registry.onChange(heard)
    const share = registry.start({ requester, origin: 'https://a.example', choice: SCREEN, audio: false, nonce: 'n' })
    expect(share).toMatchObject({ id: 'share-1', origin: 'https://a.example', kind: 'screen', label: 'Entire screen', audio: false, startedAt: 42 })
    expect(share.captured).toBeUndefined()
    expect(registry.list()).toEqual([share])
    expect(registry.forRequester(requester)).toEqual([share])
    expect(registry.forCaptured(shown)).toEqual([])
    expect(heard).toHaveBeenCalledOnce()
    expect(deps.markInUse).toHaveBeenCalledWith(requester)
  })

  it('knows the tab a tab share shows', () => {
    const { registry } = setup()
    const share = registry.start({ requester, origin: 'https://a.example', choice: TAB, audio: true, nonce: 'n' })
    expect(share.captured).toBe(shown)
    expect(registry.forCaptured(shown)).toEqual([share])
  })

  it('sends Stop to the requester with the share\'s nonce, and keeps the share until the tracks report ended', () => {
    const { registry, deps } = setup()
    const share = registry.start({ requester, origin: 'https://a.example', choice: SCREEN, audio: false, nonce: 'nonce-1' })
    registry.stop(share.id)
    expect(deps.sendStop).toHaveBeenCalledWith(requester, 'nonce-1')
    expect(registry.list()).toHaveLength(1)
    registry.stop('gone')
    expect(deps.sendStop).toHaveBeenCalledOnce()
  })

  it('ends the share when the tracks report ended for its nonce, and for no other', () => {
    const { registry, deps } = setup()
    registry.start({ requester, origin: 'https://a.example', choice: SCREEN, audio: false, nonce: 'nonce-1' })
    registry.tracksEnded(requester, 'other')
    registry.tracksEnded({ id: 9 } as never, 'nonce-1')
    expect(registry.list()).toHaveLength(1)
    registry.tracksEnded(requester, 'nonce-1')
    expect(registry.list()).toEqual([])
    expect(deps.clearInUse).toHaveBeenCalledWith(requester)
  })

  it('ends the share when its requester loads another document or goes away', () => {
    const { registry, watchers } = setup()
    registry.start({ requester, origin: 'https://a.example', choice: SCREEN, audio: false, nonce: 'n' })
    watchers.get(requester)?.[0]?.()
    expect(registry.list()).toEqual([])
  })

  it('ends a tab share when the tab it shows goes away', () => {
    const { registry, watchers } = setup()
    registry.start({ requester, origin: 'https://a.example', choice: TAB, audio: false, nonce: 'n' })
    watchers.get(shown)?.[0]?.()
    expect(registry.list()).toEqual([])
  })

  it('keeps the requester marked in use until its last share ends', () => {
    const { registry, deps } = setup()
    const first = registry.start({ requester, origin: 'https://a.example', choice: SCREEN, audio: false, nonce: 'a' })
    registry.start({ requester, origin: 'https://a.example', choice: SCREEN, audio: false, nonce: 'b' })
    registry.tracksEnded(requester, 'a')
    expect(deps.clearInUse).not.toHaveBeenCalled()
    registry.tracksEnded(requester, 'b')
    expect(deps.clearInUse).toHaveBeenCalledOnce()
    expect(first.id).toBe('share-1')
  })

  it('ends a tab share once the tab was seen captured and then is not, and not before', () => {
    const { registry, capturing, tick } = setup()
    registry.start({ requester, origin: 'https://a.example', choice: TAB, audio: false, nonce: 'n' })
    tick()
    expect(registry.list()).toHaveLength(1)
    capturing.add(shown)
    tick()
    expect(registry.list()).toHaveLength(1)
    capturing.delete(shown)
    tick()
    expect(registry.list()).toEqual([])
  })

  it('polls only while a tab share runs', () => {
    const { registry, pollers } = setup()
    expect(pollers()).toBe(0)
    registry.start({ requester, origin: 'https://a.example', choice: SCREEN, audio: false, nonce: 's' })
    expect(pollers()).toBe(0)
    registry.start({ requester, origin: 'https://a.example', choice: TAB, audio: false, nonce: 't' })
    registry.start({ requester, origin: 'https://a.example', choice: TAB, audio: false, nonce: 'u' })
    expect(pollers()).toBe(1)
    registry.tracksEnded(requester, 't')
    expect(pollers()).toBe(1)
    registry.tracksEnded(requester, 'u')
    expect(pollers()).toBe(0)
  })

  it('stops watching the contents of a share that ended', () => {
    const { registry, watchers } = setup()
    registry.start({ requester, origin: 'https://a.example', choice: TAB, audio: false, nonce: 'n' })
    registry.tracksEnded(requester, 'n')
    expect(watchers.get(requester)).toEqual([])
    expect(watchers.get(shown)).toEqual([])
  })

  it('survives a listener that throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const { registry } = setup()
      const heard = vi.fn()
      registry.onChange(() => { throw new Error('boom') })
      registry.onChange(heard)
      registry.start({ requester, origin: 'https://a.example', choice: SCREEN, audio: false, nonce: 'n' })
      expect(heard).toHaveBeenCalledOnce()
    } finally {
      error.mockRestore()
    }
  })

  it('stops notifying a listener that unsubscribed', () => {
    const { registry } = setup()
    const heard = vi.fn()
    registry.onChange(heard)()
    registry.start({ requester, origin: 'https://a.example', choice: SCREEN, audio: false, nonce: 'n' })
    expect(heard).not.toHaveBeenCalled()
  })
})
