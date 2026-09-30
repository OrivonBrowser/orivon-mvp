import { describe, expect, it, vi } from 'vitest'
import type { OverlayHandler, OverlayWindow } from '../../overlays/overlay-types.js'
import { findOverlay } from '../find-overlay.js'
import { findWindowFor } from '../find-window.js'

interface FakeContents {
  id: string
  findInPage: ReturnType<typeof vi.fn>
  stopFindInPage: ReturnType<typeof vi.fn>
  isDestroyed: () => boolean
  isCrashed: () => boolean
  isLoadingMainFrame: () => boolean
  mainFrame: { executeJavaScript: ReturnType<typeof vi.fn> }
}

function contents (id: string, selection = ''): FakeContents {
  let next = 0
  return {
    id,
    findInPage: vi.fn(() => { next += 1; return next }),
    stopFindInPage: vi.fn(),
    isDestroyed: () => false,
    isCrashed: () => false,
    isLoadingMainFrame: () => false,
    mainFrame: { executeJavaScript: vi.fn(async () => await Promise.resolve(selection)) }
  }
}

interface Rig {
  handler: OverlayHandler
  send: ReturnType<typeof vi.fn>
  tabs: Map<string, FakeContents>
  setActive: (id: string) => void
  open: { value: boolean }
  shown: ReturnType<typeof vi.fn>
  lifecycle: { tabActivated: (wc: unknown) => void, tabClosing: (info: { id: string }) => void }
  window: object
  answer: (id: string, requestId: number, active: number, matches: number, finalUpdate?: boolean) => void
}

function rig (initial: Record<string, FakeContents>): Rig {
  const tabs = new Map(Object.entries(initial))
  let active = [...tabs.keys()][0] ?? null
  const open = { value: false }
  const shown = vi.fn()
  const send = vi.fn()
  let lifecycle = { tabActivated: (_wc: unknown) => {}, tabClosing: (_info: { id: string }) => {} }
  const window = {
    window: { isDestroyed: () => false },
    tabs: {
      getState: () => ({ activeTabId: active }),
      liveWebContents: (id: string) => tabs.get(id),
      findTabIdByWebContents: (wc: FakeContents) => [...tabs].find(([, candidate]) => candidate === wc)?.[0] ?? null
    },
    overlays: { isOpen: () => open.value, show: shown }
  }
  const win = {
    window,
    services: { tabLifecycle: { subscribe: (listener: typeof lifecycle) => { lifecycle = listener; return () => {} } } },
    send,
    close: vi.fn()
  } as unknown as OverlayWindow
  const handler = findOverlay.attach(win)
  const bar = findWindowFor(window as never)
  return {
    handler, send, tabs, open, shown, window,
    setActive: (id) => { active = id },
    get lifecycle () { return lifecycle },
    answer: (id, requestId, activeMatch, matches, finalUpdate = true) => {
      bar?.result(tabs.get(id) as never, { requestId, activeMatchOrdinal: activeMatch, matches, finalUpdate })
    }
  }
}

const query = (text: string, matchCase = false): unknown => ({ type: 'query', text, matchCase })

async function opened (r: Rig, payload?: unknown): Promise<unknown> {
  const reply = await r.handler.show?.(payload)
  r.open.value = true
  return reply
}

describe('the find bar handler', () => {
  it('opens empty the first time, and searches on every query it is sent', async () => {
    const a = contents('a')
    const r = rig({ a })

    expect(await opened(r)).toEqual({ query: '', matchCase: false, fresh: true })
    r.handler.request(query('ori'))
    r.handler.request(query('orivon', true))

    expect(a.findInPage).toHaveBeenNthCalledWith(1, 'ori', { findNext: true, forward: true, matchCase: false })
    expect(a.findInPage).toHaveBeenNthCalledWith(2, 'orivon', { findNext: true, forward: true, matchCase: true })
  })

  it('steps with findNext off, and forwards only the newest answer to the page', async () => {
    const a = contents('a')
    const r = rig({ a })
    await opened(r)
    r.handler.request(query('orivon'))

    r.handler.request({ type: 'step', forward: true })
    r.answer('a', 1, 1, 5)
    r.answer('a', 2, 2, 5)

    expect(a.findInPage).toHaveBeenLastCalledWith('orivon', { findNext: false, forward: true, matchCase: false })
    expect(r.send).toHaveBeenCalledTimes(1)
    expect(r.send).toHaveBeenCalledWith({ type: 'result', active: 2, total: 5 })
  })

  it('ignores a request that is not exactly one of the two it knows', async () => {
    const a = contents('a')
    const r = rig({ a })
    await opened(r)

    for (const bad of [undefined, 'find', { type: 'query', text: 'x'.repeat(600), matchCase: false }, { type: 'query', text: 'x', matchCase: 'no' }, { type: 'step', forward: 'yes' }, { type: 'run', id: 'app.quit' }]) {
      r.handler.request(bad)
    }

    expect(a.findInPage).not.toHaveBeenCalled()
    expect(a.stopFindInPage).not.toHaveBeenCalled()
  })

  it('clears the search when the query is emptied', async () => {
    const a = contents('a')
    const r = rig({ a })
    await opened(r)
    r.handler.request(query('orivon'))

    r.handler.request(query(''))

    expect(a.stopFindInPage).toHaveBeenCalledWith('clearSelection')
  })

  it('does nothing while it is closed: a request for a tab it does not search is refused', async () => {
    const a = contents('a')
    const r = rig({ a })

    r.handler.request(query('orivon'))

    expect(a.findInPage).not.toHaveBeenCalled()
  })

  it('keeps the selection on Escape and on the close button, and clears it for any other close', async () => {
    for (const [reason, action] of [['escape', 'keepSelection'], ['request', 'keepSelection'], ['navigation', 'clearSelection'], ['blur', 'clearSelection']] as const) {
      const a = contents('a')
      const r = rig({ a })
      await opened(r)
      r.handler.request(query('orivon'))

      r.handler.closed?.(reason)

      expect(a.stopFindInPage, reason).toHaveBeenCalledWith(action)
    }
  })

  it('pre-fills the last query, selected, on the next open', async () => {
    const a = contents('a')
    const r = rig({ a })
    await opened(r)
    r.handler.request(query('orivon', true))
    r.handler.closed?.('escape')
    r.open.value = false

    expect(await opened(r)).toEqual({ query: 'orivon', matchCase: true, fresh: true })
    expect(a.findInPage).toHaveBeenLastCalledWith('orivon', { findNext: true, forward: true, matchCase: true })
  })

  it('keeps the queries of two tabs apart, and clears the tab it is left', async () => {
    const a = contents('a')
    const b = contents('b')
    const r = rig({ a, b })
    await opened(r)
    r.handler.request(query('alpha'))

    r.setActive('b')
    r.handler.closed?.('tab-switch')
    r.open.value = false

    expect(a.stopFindInPage).toHaveBeenCalledWith('clearSelection')
    expect(b.stopFindInPage).not.toHaveBeenCalled()
    r.handler.request(query('beta'))
    expect(b.findInPage).not.toHaveBeenCalled()
  })

  it('brings the bar back, with its query, when the tab it was left on returns', async () => {
    vi.useFakeTimers()
    try {
      const a = contents('a')
      const b = contents('b')
      const r = rig({ a, b })
      await opened(r)
      r.handler.request(query('alpha', true))
      r.setActive('b')
      r.handler.closed?.('tab-switch')
      r.open.value = false

      r.setActive('a')
      r.lifecycle.tabActivated(a)
      await vi.runAllTimersAsync()

      expect(r.shown).toHaveBeenCalledWith('find')
      expect(await r.handler.show?.(undefined)).toEqual({ query: 'alpha', matchCase: true, fresh: true })
      expect(a.findInPage).toHaveBeenLastCalledWith('alpha', { findNext: true, forward: true, matchCase: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not bring the bar back to a tab whose bar was closed on purpose', async () => {
    vi.useFakeTimers()
    try {
      const a = contents('a')
      const r = rig({ a })
      await opened(r)
      r.handler.request(query('alpha'))
      r.handler.closed?.('escape')
      r.open.value = false

      r.lifecycle.tabActivated(a)
      await vi.runAllTimersAsync()

      expect(r.shown).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips the clean-up of a tab that closed while the bar was open', async () => {
    const a = contents('a')
    const b = contents('b')
    const r = rig({ a, b })
    await opened(r)
    r.handler.request(query('alpha'))
    r.tabs.delete('a')
    r.lifecycle.tabClosing({ id: 'a' })
    r.setActive('b')

    expect(() => { r.handler.closed?.('tab-switch') }).not.toThrow()
    expect(b.stopFindInPage).not.toHaveBeenCalled()
  })

  it('opened again while open, only takes focus back', async () => {
    const a = contents('a')
    const r = rig({ a })
    await opened(r)
    r.handler.request(query('orivon'))
    a.findInPage.mockClear()

    expect(await r.handler.show?.(undefined)).toEqual({ query: 'orivon', matchCase: false, fresh: false })
    expect(a.findInPage).not.toHaveBeenCalled()
  })

  it('pre-fills a short one-line selection when there is no earlier query', async () => {
    const a = contents('a', '  word  ')
    const r = rig({ a })

    expect(await opened(r)).toEqual({ query: 'word', matchCase: false, fresh: true })
    expect(a.findInPage).toHaveBeenCalledWith('word', { findNext: true, forward: true, matchCase: false })
  })

  it.each([
    ['a selection over two lines', 'one\ntwo'],
    ['a selection of 100 characters', 'x'.repeat(100)],
    ['no selection', '']
  ])('does not pre-fill %s', async (_name, selection) => {
    const a = contents('a', selection)
    const r = rig({ a })

    expect(await opened(r)).toEqual({ query: '', matchCase: false, fresh: true })
    expect(a.findInPage).not.toHaveBeenCalled()
  })

  it('opens without the selection when the page never answers', async () => {
    vi.useFakeTimers()
    try {
      const a = contents('a')
      a.mainFrame.executeJavaScript.mockReturnValue(new Promise(() => {}))
      const r = rig({ a })

      const reply = r.handler.show?.(undefined)
      await vi.advanceTimersByTimeAsync(200)

      expect(await reply).toEqual({ query: '', matchCase: false, fresh: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes the step a closed-bar Find next asked for once the first answer shows several matches', async () => {
    const a = contents('a')
    const r = rig({ a })
    await opened(r)
    r.handler.request(query('orivon'))
    r.handler.closed?.('escape')
    r.open.value = false

    await opened(r, { step: false })
    a.findInPage.mockClear()
    r.answer('a', 2, 1, 4)

    expect(a.findInPage).toHaveBeenCalledWith('orivon', { findNext: false, forward: false, matchCase: false })
  })

  it('blanks the count when the page starts loading and searches again when it stops', async () => {
    const a = contents('a')
    const r = rig({ a })
    await opened(r)
    r.open.value = true
    r.handler.request(query('orivon'))
    a.findInPage.mockClear()
    const bar = findWindowFor(r.window as never)

    bar?.loading(a as never, 'start')
    bar?.loading(a as never, 'stop')

    expect(r.send).toHaveBeenCalledWith({ type: 'reset' })
    expect(a.findInPage).toHaveBeenCalledWith('orivon', { findNext: true, forward: true, matchCase: false })
  })

  it('ignores an answer from a tab that is not the one it searches', async () => {
    const a = contents('a')
    const b = contents('b')
    const r = rig({ a, b })
    await opened(r)
    r.open.value = true
    r.handler.request(query('orivon'))

    r.answer('b', 1, 1, 3)

    expect(r.send).not.toHaveBeenCalled()
  })

  it('stays closed and quiet with no tab to search', async () => {
    const r = rig({})

    expect(await opened(r)).toEqual({ query: '', matchCase: false, fresh: true })
    r.handler.request(query('orivon'))
    expect(() => { r.handler.closed?.('escape') }).not.toThrow()
  })
})
