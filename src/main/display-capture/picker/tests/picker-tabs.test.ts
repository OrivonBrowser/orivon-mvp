import { describe, expect, it, vi } from 'vitest'
import type { TabState } from '../../../shell/tab-types.js'
import { offeredTabs } from '../picker-tabs.js'
import type { TabWindow } from '../picker-tabs.js'

interface Fake { id: number, destroyed: boolean, isDestroyed: () => boolean }
const wc = (id: number, destroyed = false): Fake => ({ id, destroyed, isDestroyed: () => destroyed })
const tab = (id: string, over: Partial<TabState> = {}): TabState => ({ id, url: `https://${id}.example/`, isInternal: false, isNewTab: false, crashed: null, ...over } as TabState)

function win (tabs: Array<{ state: TabState, contents?: Fake }>, destroyed = false): TabWindow {
  return {
    window: { isDestroyed: () => destroyed },
    tabs: {
      getState: () => ({ tabs: tabs.map((entry) => entry.state) }),
      liveWebContents: (id) => tabs.find((entry) => entry.state.id === id)?.contents as never
    }
  }
}

describe('offeredTabs', () => {
  it('offers the asking tab first, then its window, then the other windows', () => {
    const a = wc(1); const b = wc(2); const c = wc(3); const d = wc(4)
    const other = win([{ state: tab('c'), contents: c }])
    const own = win([{ state: tab('a'), contents: a }, { state: tab('b'), contents: b }, { state: tab('d'), contents: d }])
    const offers = offeredTabs([other, own], { tab: b as never, hints: {} })
    expect(offers.map((offer) => [offer.wc, offer.self])).toEqual([[b, true], [a, false], [d, false], [c, false]])
  })

  it('leaves out Orivon pages, new tabs, extension pages, sleeping, crashed and gone tabs', () => {
    const live = wc(1)
    const windows = [win([
      { state: tab('ok'), contents: live },
      { state: tab('internal', { isInternal: true }), contents: wc(2) },
      { state: tab('new', { isNewTab: true }), contents: wc(3) },
      { state: tab('ext', { url: 'chrome-extension://abc/p.html' }), contents: wc(4) },
      { state: tab('sleep', { sleeping: true }), contents: wc(5) },
      { state: tab('crash', { crashed: 'killed' }), contents: wc(6) },
      { state: tab('dead'), contents: wc(7, true) },
      { state: tab('nolive') }
    ])]
    expect(offeredTabs(windows, { tab: live as never, hints: {} }).map((offer) => offer.tab.id)).toEqual(['ok'])
  })

  it('drops the asking tab when the page asks for it to be excluded', () => {
    const a = wc(1); const b = wc(2)
    const windows = [win([{ state: tab('a'), contents: a }, { state: tab('b'), contents: b }])]
    expect(offeredTabs(windows, { tab: a as never, hints: { selfBrowserSurface: 'exclude' } }).map((offer) => offer.tab.id)).toEqual(['b'])
    expect(offeredTabs(windows, { tab: a as never, hints: { selfBrowserSurface: 'include' } }).map((offer) => offer.tab.id)).toEqual(['a', 'b'])
  })

  it('skips a window that is being destroyed', () => {
    const a = wc(1)
    expect(offeredTabs([win([{ state: tab('a'), contents: a }], true)], { tab: a as never, hints: {} })).toEqual([])
  })

  it('reads each window\'s tab state once per call', () => {
    const a = wc(1); const b = wc(2); const c = wc(3)
    const first = win([{ state: tab('c'), contents: c }])
    const second = win([{ state: tab('a'), contents: a }, { state: tab('b'), contents: b }])
    const reads = [first, second].map((entry) => vi.spyOn(entry.tabs, 'getState'))
    offeredTabs([first, second], { tab: b as never, hints: {} })
    expect(reads.map((read) => read.mock.calls.length)).toEqual([1, 1])
  })
})
