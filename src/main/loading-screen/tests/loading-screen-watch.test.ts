import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { SlotAsk } from '../../overlays/tab-slots.js'
import type { ShellWindow } from '../../shell/window-registry.js'
import { SHOW_AFTER_MS, watchLoadingScreen } from '../loading-screen-watch.js'
import type { LoadingScreenDeps } from '../loading-screen-watch.js'

const WINDOW = {} as unknown as ShellWindow
const IPFS = 'https://bafy.ipfs.orivon/'
const OTHER = 'https://example.com/'

function setup (): { contents: EventEmitter, asks: SlotAsk[], cancels: Array<ReturnType<typeof vi.fn>>, prewarmed: ShellWindow[], deps: LoadingScreenDeps } {
  const contents = new EventEmitter()
  const asks: SlotAsk[] = []
  const cancels: Array<ReturnType<typeof vi.fn>> = []
  const prewarmed: ShellWindow[] = []
  return {
    contents, asks, cancels, prewarmed,
    deps: {
      findTab: (candidate) => candidate === (contents as unknown as WebContents) ? { window: WINDOW, tabId: 't1' } : null,
      ask: (ask) => {
        asks.push(ask)
        const cancel = vi.fn(() => { ask.closed('request') })
        cancels.push(cancel)
        return { cancel }
      },
      screenFor: (url) => url.includes('.ipfs.orivon') || url.startsWith('https://ipfs.orivon/') ? { title: 'Loading from IPFS' } : undefined,
      prewarm: (window) => { prewarmed.push(window) }
    }
  }
}

const start = (s: ReturnType<typeof setup>, url: string, extra: Record<string, unknown> = {}): void => {
  s.contents.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false, ...extra })
}

function watched (): ReturnType<typeof setup> {
  const s = setup()
  watchLoadingScreen(s.contents as unknown as WebContents, s.deps)
  return s
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('the loading-screen watcher: when the cover goes up', () => {
  it('asks for nothing before the delay, then asks for the cover slot of the tab with the address', () => {
    const s = watched()
    start(s, IPFS)
    vi.advanceTimersByTime(SHOW_AFTER_MS - 1)
    expect(s.asks).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(s.asks).toHaveLength(1)
    expect(s.asks[0]).toMatchObject({ window: WINDOW, tabId: 't1', slot: 'cover', overlay: 'loading-screen', payload: { url: IPFS } })
  })

  it('prewarms the overlay in the tab\'s window as the navigation starts', () => {
    const s = watched()
    start(s, IPFS)
    expect(s.prewarmed).toEqual([WINDOW])
  })

  it('never asks when the page is ready sooner than the delay', () => {
    const s = watched()
    start(s, IPFS)
    s.contents.emit('did-navigate', {}, IPFS)
    vi.advanceTimersByTime(100)
    s.contents.emit('dom-ready')
    vi.advanceTimersByTime(1000)
    expect(s.asks).toHaveLength(0)
  })

  it('ignores a subframe, a same-document navigation and an address with no screen', () => {
    const s = watched()
    start(s, IPFS, { isMainFrame: false })
    start(s, IPFS, { isSameDocument: true })
    start(s, OTHER)
    vi.advanceTimersByTime(1000)
    expect(s.asks).toHaveLength(0)
    expect(s.prewarmed).toHaveLength(0)
  })

  it('asks again at once, with the new address, when another screened navigation starts while it is up', () => {
    const s = watched()
    start(s, IPFS)
    vi.advanceTimersByTime(SHOW_AFTER_MS)
    start(s, 'https://other.ipfs.orivon/')
    expect(s.asks).toHaveLength(2)
    expect(s.asks[1]?.payload).toEqual({ url: 'https://other.ipfs.orivon/' })
    // The first ask ended in the replacement and must not read as the screen going away.
    s.asks[0]?.closed('replaced')
    start(s, 'https://third.ipfs.orivon/')
    expect(s.asks).toHaveLength(3)
  })

  it('restarts the delay for a newer navigation that starts before the screen is up', () => {
    const s = watched()
    start(s, IPFS)
    vi.advanceTimersByTime(200)
    start(s, 'https://other.ipfs.orivon/')
    vi.advanceTimersByTime(200)
    expect(s.asks).toHaveLength(0)
    vi.advanceTimersByTime(100)
    expect(s.asks).toHaveLength(1)
    expect(s.asks[0]?.payload).toEqual({ url: 'https://other.ipfs.orivon/' })
  })

  it('does nothing for a tab the window does not know', () => {
    const s = setup()
    s.deps = { ...s.deps, findTab: () => null }
    watchLoadingScreen(s.contents as unknown as WebContents, s.deps)
    start(s, IPFS)
    vi.advanceTimersByTime(1000)
    expect(s.asks).toHaveLength(0)
  })

  it('watches a web contents once however often it is handed over', () => {
    const s = setup()
    watchLoadingScreen(s.contents as unknown as WebContents, s.deps)
    watchLoadingScreen(s.contents as unknown as WebContents, s.deps)
    start(s, IPFS)
    vi.advanceTimersByTime(SHOW_AFTER_MS)
    expect(s.asks).toHaveLength(1)
  })
})

describe('the loading-screen watcher: when it goes away', () => {
  function shown (): ReturnType<typeof setup> {
    const s = watched()
    start(s, IPFS)
    vi.advanceTimersByTime(SHOW_AFTER_MS)
    return s
  }

  it('ignores a dom-ready that comes before the new page committed (the previous page\'s own)', () => {
    const s = shown()
    s.contents.emit('dom-ready')
    expect(s.cancels[0]).not.toHaveBeenCalled()
  })

  it('takes the cover away at the dom-ready of the committed page', () => {
    const s = shown()
    s.contents.emit('did-navigate', {}, IPFS)
    s.contents.emit('dom-ready')
    expect(s.cancels[0]).toHaveBeenCalledTimes(1)
  })

  it('does not trust a commit from an earlier navigation: a new one resets it', () => {
    const s = watched()
    start(s, IPFS)
    s.contents.emit('did-navigate', {}, IPFS)
    start(s, 'https://other.ipfs.orivon/')
    vi.advanceTimersByTime(SHOW_AFTER_MS)
    s.contents.emit('dom-ready')
    expect(s.cancels[0]).not.toHaveBeenCalled()
  })

  it('leaves an aborted load alone (a newer navigation replaced it) and withdraws on any other failure', () => {
    const s = shown()
    s.contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', IPFS, true)
    expect(s.cancels[0]).not.toHaveBeenCalled()
    s.contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', IPFS, false)
    expect(s.cancels[0]).not.toHaveBeenCalled()
    s.contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', IPFS, true)
    expect(s.cancels[0]).toHaveBeenCalledTimes(1)
  })

  it('withdraws when the navigation redirects to an address with no screen, and keeps it for one with', () => {
    const s = shown()
    s.contents.emit('did-redirect-navigation', { url: 'https://cid.ipfs.orivon/', isMainFrame: true })
    s.contents.emit('did-redirect-navigation', { url: OTHER, isMainFrame: false })
    expect(s.cancels[0]).not.toHaveBeenCalled()
    s.contents.emit('did-redirect-navigation', { url: OTHER, isMainFrame: true })
    expect(s.cancels[0]).toHaveBeenCalledTimes(1)
  })

  it('withdraws when loading stops, however it ended', () => {
    const s = shown()
    s.contents.emit('did-stop-loading')
    expect(s.cancels[0]).toHaveBeenCalledTimes(1)
  })

  it('withdraws when the next navigation has no screen', () => {
    const s = shown()
    start(s, OTHER)
    expect(s.cancels[0]).toHaveBeenCalledTimes(1)
  })

  it('withdraws when the renderer dies or the contents are destroyed, and cancels a pending delay', () => {
    const s = shown()
    s.contents.emit('render-process-gone')
    expect(s.cancels[0]).toHaveBeenCalledTimes(1)

    const t = watched()
    start(t, IPFS)
    t.contents.emit('destroyed')
    vi.advanceTimersByTime(1000)
    expect(t.asks).toHaveLength(0)
  })

  it('never asks after a withdrawal that came before the delay ran out', () => {
    const s = watched()
    start(s, IPFS)
    s.contents.emit('did-stop-loading')
    vi.advanceTimersByTime(1000)
    expect(s.asks).toHaveLength(0)
  })

  it('withdraws once: later events find nothing to cancel', () => {
    const s = shown()
    s.contents.emit('did-stop-loading')
    s.contents.emit('did-stop-loading')
    s.contents.emit('destroyed')
    expect(s.cancels[0]).toHaveBeenCalledTimes(1)
  })

  it('is asked for again by the next screened navigation after one ended', () => {
    const s = shown()
    s.contents.emit('did-stop-loading')
    start(s, IPFS)
    vi.advanceTimersByTime(SHOW_AFTER_MS)
    expect(s.asks).toHaveLength(2)
  })

  it('counts an ask that ended on its own (queue full or a failed show) as no screen up', () => {
    const s = setup()
    const asks: SlotAsk[] = []
    watchLoadingScreen(s.contents as unknown as WebContents, {
      ...s.deps,
      ask: (ask) => { asks.push(ask); ask.closed('queue-full'); return { cancel: vi.fn() } }
    })
    start(s, IPFS)
    vi.advanceTimersByTime(SHOW_AFTER_MS)
    start(s, IPFS)
    // No ask is live, so the second navigation waits for its delay again instead of asking at once.
    expect(asks).toHaveLength(1)
    vi.advanceTimersByTime(SHOW_AFTER_MS)
    expect(asks).toHaveLength(2)
  })
})

describe('the loading-screen watcher: a first visit owns the cover', () => {
  it('asks for nothing while the tab is claimed, whether the delay or an already-up screen would have asked', () => {
    const s = setup()
    let claimed = true
    watchLoadingScreen(s.contents as unknown as WebContents, { ...s.deps, claimed: () => claimed })
    start(s, IPFS)
    vi.advanceTimersByTime(SHOW_AFTER_MS)
    expect(s.asks).toHaveLength(0)
    claimed = false
    start(s, IPFS)
    vi.advanceTimersByTime(SHOW_AFTER_MS)
    expect(s.asks).toHaveLength(1)
    claimed = true
    start(s, IPFS)
    expect(s.asks).toHaveLength(1)
  })
})
