import { describe, expect, it, vi } from 'vitest'
import { CAPTURE_POLL_MS, createShareRegistry, type ShareRegistryDeps } from '../share-registry.js'
import { TICKET_TIMEOUT_MS } from '../display-tickets.js'
import type { DisplayChoice } from '../types.js'

const requester = { id: 1 } as never
const shown = { id: 2 } as never

const SCREEN: DisplayChoice = { kind: 'screen', source: { id: 'screen:0:0', name: 'Entire screen' }, systemAudio: false, label: 'Entire screen' }
const TAB: DisplayChoice = { kind: 'tab', tab: shown, audio: true, label: 'A tab' }

function setup (): {
  registry: ReturnType<typeof createShareRegistry>
  deps: ShareRegistryDeps
  watchers: Map<unknown, Array<() => void>>
  tabWatchers: Map<unknown, Array<() => void>>
  capturing: Set<unknown>
  tick: () => void
  pollers: () => number
  timers: Map<number, () => void>
} {
  const watchers = new Map<unknown, Array<() => void>>()
  const tabWatchers = new Map<unknown, Array<() => void>>()
  const capturing = new Set<unknown>()
  let counter = 0
  let polling: (() => void) | undefined
  let pollers = 0
  const timers = new Map<number, () => void>()
  let timerId = 0
  const deps: ShareRegistryDeps = {
    now: () => 42,
    newId: () => `share-${++counter}`,
    watch: (contents, ended) => {
      const list = watchers.get(contents) ?? []
      list.push(ended)
      watchers.set(contents, list)
      return () => { watchers.set(contents, (watchers.get(contents) ?? []).filter((fn) => fn !== ended)) }
    },
    watchTab: (contents, ended) => {
      const list = tabWatchers.get(contents) ?? []
      list.push(ended)
      tabWatchers.set(contents, list)
      return () => { tabWatchers.set(contents, (tabWatchers.get(contents) ?? []).filter((fn) => fn !== ended)) }
    },
    isBeingCaptured: (contents) => capturing.has(contents),
    setTimer: (run, ms) => { expect(ms).toBe(TICKET_TIMEOUT_MS); timers.set(++timerId, run); return timerId },
    clearTimer: (handle) => { timers.delete(handle as number) },
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
  return { registry: createShareRegistry(deps), deps, watchers, tabWatchers, capturing, tick: () => { polling?.() }, pollers: () => pollers, timers }
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
    registry.received(requester, 'nonce-1')
    registry.tracksEnded(requester, 'other')
    registry.tracksEnded({ id: 9 } as never, 'nonce-1')
    expect(registry.list()).toHaveLength(1)
    registry.tracksEnded(requester, 'nonce-1')
    expect(registry.list()).toEqual([])
    expect(deps.clearInUse).toHaveBeenCalledWith(requester)
  })

  describe('confirming a share', () => {
    const begin = (): ReturnType<typeof setup> => {
      const harness = setup()
      harness.registry.start({ requester, origin: 'https://a.example', choice: SCREEN, audio: false, nonce: 'nonce-1' })
      return harness
    }

    it('ignores the tracks ending until the preload reports its call received the stream', () => {
      const { registry } = begin()
      registry.tracksEnded(requester, 'nonce-1')
      expect(registry.list()).toHaveLength(1)
      registry.received({ id: 9 } as never, 'nonce-1')
      registry.received(requester, 'other')
      registry.tracksEnded(requester, 'nonce-1')
      expect(registry.list()).toHaveLength(1)
      registry.received(requester, 'nonce-1')
      registry.tracksEnded(requester, 'nonce-1')
      expect(registry.list()).toEqual([])
    })

    it('ends an unconfirmed share when the preload\'s call failed, and says it did', () => {
      const { registry, deps } = begin()
      expect(registry.failed(requester, 'other')).toBe(false)
      expect(registry.failed({ id: 9 } as never, 'nonce-1')).toBe(false)
      expect(registry.list()).toHaveLength(1)
      expect(registry.failed(requester, 'nonce-1')).toBe(true)
      expect(registry.list()).toEqual([])
      expect(deps.clearInUse).toHaveBeenCalledWith(requester)
      expect(registry.failed(requester, 'nonce-1')).toBe(false)
    })

    it('does not end a confirmed share for a failure report', () => {
      const { registry } = begin()
      registry.received(requester, 'nonce-1')
      expect(registry.failed(requester, 'nonce-1')).toBe(false)
      expect(registry.list()).toHaveLength(1)
    })

    it('keeps an unconfirmed share listed indefinitely: the sharing bar stays while the page is busy', () => {
      const { registry, timers } = begin()
      for (const run of [...timers.values()]) run()
      expect(registry.list()).toHaveLength(1)
    })

    it('sends Stop again when the share is confirmed after Stop was pressed, since the preload had no tracks the first time', () => {
      const { registry, deps } = begin()
      registry.stop('share-1')
      expect(deps.sendStop).toHaveBeenCalledTimes(1)
      registry.received(requester, 'nonce-1')
      expect(deps.sendStop).toHaveBeenCalledTimes(2)
      expect(deps.sendStop).toHaveBeenLastCalledWith(requester, 'nonce-1')
    })

    it('sends no second Stop for a share that was confirmed first', () => {
      const { registry, deps } = begin()
      registry.received(requester, 'nonce-1')
      registry.stop('share-1')
      expect(deps.sendStop).toHaveBeenCalledTimes(1)
    })

    it('ends an unconfirmed share when its requester loads another document', () => {
      const { registry, watchers } = begin()
      for (const ended of [...(watchers.get(requester) ?? [])]) ended()
      expect(registry.list()).toEqual([])
    })
  })

  it('ends the share when its requester loads another document or goes away', () => {
    const { registry, watchers } = setup()
    registry.start({ requester, origin: 'https://a.example', choice: SCREEN, audio: false, nonce: 'n' })
    watchers.get(requester)?.[0]?.()
    expect(registry.list()).toEqual([])
  })

  it('ends a tab share when the tab it shows goes away', () => {
    const { registry, tabWatchers } = setup()
    registry.start({ requester, origin: 'https://a.example', choice: TAB, audio: false, nonce: 'n' })
    tabWatchers.get(shown)?.[0]?.()
    expect(registry.list()).toEqual([])
  })

  it('does not watch the shown tab for loading another document: Chromium keeps capturing it', () => {
    const { registry, watchers } = setup()
    registry.start({ requester, origin: 'https://a.example', choice: TAB, audio: false, nonce: 'n' })
    expect(watchers.get(shown) ?? []).toEqual([])
    expect(registry.list()).toHaveLength(1)
  })

  it('keeps the requester marked in use until its last share ends', () => {
    const { registry, deps } = setup()
    const first = registry.start({ requester, origin: 'https://a.example', choice: SCREEN, audio: false, nonce: 'a' })
    registry.start({ requester, origin: 'https://a.example', choice: SCREEN, audio: false, nonce: 'b' })
    registry.received(requester, 'a')
    registry.received(requester, 'b')
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
    registry.received(requester, 't')
    registry.received(requester, 'u')
    registry.tracksEnded(requester, 't')
    expect(pollers()).toBe(1)
    registry.tracksEnded(requester, 'u')
    expect(pollers()).toBe(0)
  })

  it('stops watching the contents of a share that ended', () => {
    const { registry, watchers, tabWatchers } = setup()
    registry.start({ requester, origin: 'https://a.example', choice: TAB, audio: false, nonce: 'n' })
    registry.received(requester, 'n')
    registry.tracksEnded(requester, 'n')
    expect(watchers.get(requester)).toEqual([])
    expect(tabWatchers.get(shown)).toEqual([])
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

  describe('a tab share that is expected', () => {
    it('marks the tab pending from the pick until the share starts, then lists it as captured', () => {
      const { registry } = setup()
      const heard = vi.fn()
      registry.onChange(heard)
      registry.expectCapture(shown, 'n')
      expect(registry.capturePending(shown)).toBe(true)
      expect(registry.capturePending(requester)).toBe(false)
      registry.start({ requester, origin: 'https://a.example', choice: TAB, audio: false, nonce: 'n' })
      expect(registry.capturePending(shown)).toBe(false)
      expect(registry.forCaptured(shown)).toHaveLength(1)
      expect(heard).toHaveBeenCalledOnce()
    })

    it('clears the mark and tells listeners when the pick is cancelled, so a kept view can be let go', () => {
      const { registry, timers } = setup()
      const heard = vi.fn()
      registry.onChange(heard)
      registry.expectCapture(shown, 'n')
      registry.cancelExpected('n')
      expect(registry.capturePending(shown)).toBe(false)
      expect(heard).toHaveBeenCalledOnce()
      expect(timers.size).toBe(0)
      registry.cancelExpected('n')
      expect(heard).toHaveBeenCalledOnce()
    })

    it('clears the mark when the ticket\'s lifetime is over, whatever became of the ticket', () => {
      const { registry, timers } = setup()
      const heard = vi.fn()
      registry.onChange(heard)
      registry.expectCapture(shown, 'n')
      ;[...timers.values()][0]?.()
      expect(registry.capturePending(shown)).toBe(false)
      expect(heard).toHaveBeenCalledOnce()
    })

    it('stays pending while any expectation for the tab is open', () => {
      const { registry } = setup()
      registry.expectCapture(shown, 'one')
      registry.expectCapture(shown, 'two')
      registry.cancelExpected('one')
      expect(registry.capturePending(shown)).toBe(true)
      registry.cancelExpected('two')
      expect(registry.capturePending(shown)).toBe(false)
    })
  })
})
