import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { markMediaInUse, mediaInUse } from '../media-in-use.js'
import { sleepSignal } from '../sleep-signal.js'

const KEPT = {
  url: 'https://a.example/page', title: 'A page', favicon: 'data:image/png;base64,AAAA', at: 1, index: 1,
  entries: [{ url: 'https://a.example/first', title: 'First' }, { url: 'https://a.example/page', title: 'A page' }, { url: 'https://a.example/next', title: 'Next' }]
}

describe('the sleep signal state', () => {
  it('reads a sleeping tab from what it kept, so the blank view does not show', () => {
    const state = sleepSignal.state?.({ sleeping: KEPT } as never, undefined)
    expect(state).toEqual({
      sleeping: true, url: 'https://a.example/page', displayUrl: 'https://a.example/page', title: 'A page',
      favicon: 'data:image/png;base64,AAAA', canGoBack: true, canGoForward: true, loading: false
    })
  })

  it('has no Back at the first entry and no Forward at the last', () => {
    expect(sleepSignal.state?.({ sleeping: { ...KEPT, index: 0 } } as never, undefined)).toMatchObject({ canGoBack: false, canGoForward: true })
    expect(sleepSignal.state?.({ sleeping: { ...KEPT, index: 2 } } as never, undefined)).toMatchObject({ canGoBack: true, canGoForward: false })
  })

  it('says only that an awake tab is awake', () => {
    expect(sleepSignal.state?.({ sleeping: null } as never, undefined)).toEqual({ sleeping: false })
    expect(sleepSignal.state?.({} as never, undefined)).toEqual({ sleeping: false })
  })
})

describe('the sleep signal wiring', () => {
  function wired (shown = true): { wc: EventEmitter, record: { sleeping: unknown, host: { emitState: ReturnType<typeof vi.fn> } } } {
    const wc = new EventEmitter()
    const record = { sleeping: KEPT as unknown, host: { emitState: vi.fn() } }
    sleepSignal.wire?.({ id: 't', record: record as never, view: {} as never, wc: wc as never, shown: () => shown })
    return { wc, record }
  }
  const nav = (wc: EventEmitter, over: object = {}): void => { wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, ...over }) }

  it('ends the sleep when the tab\'s page starts navigating', () => {
    const { wc, record } = wired()
    nav(wc)
    expect(record.sleeping).toBeNull()
    expect(record.host.emitState).toHaveBeenCalledTimes(1)
  })

  it('ignores a subframe, an in-page change and a view the tab no longer shows', () => {
    const { wc, record } = wired()
    nav(wc, { isMainFrame: false })
    nav(wc, { isSameDocument: true })
    expect(record.sleeping).toBe(KEPT)
    const gone = wired(false)
    nav(gone.wc)
    expect(gone.record.sleeping).toBe(KEPT)
  })

  it('does nothing for an awake tab, and forgets a device a page was using once it navigates', () => {
    const { wc, record } = wired()
    record.sleeping = null
    markMediaInUse(wc as never)
    nav(wc)
    expect(record.host.emitState).not.toHaveBeenCalled()
    expect(mediaInUse(wc as never)).toBe(false)
  })
})
