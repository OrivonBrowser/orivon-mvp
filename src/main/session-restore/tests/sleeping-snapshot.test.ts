import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import type { SleepingTab } from '../../shell/tab-extra-types.js'
import type { TabRecord } from '../../shell/tab-types.js'
import { snapshotOf } from '../tab-snapshot.js'

// A sleeping tab's view is blank: what is written down is what sleeping kept.
const blank = { isDestroyed: () => false, getURL: () => '', getTitle: () => '', navigationHistory: { getAllEntries: () => [], getActiveIndex: () => 0 } } as unknown as WebContents
const destroyed = { ...blank, isDestroyed: () => true } as unknown as WebContents

const asleep = (extra: Partial<SleepingTab> = {}): SleepingTab => ({ url: 'https://a.example/two', title: 'Two', favicon: null, entries: [], index: 0, at: 1, ...extra })
const recordOf = (sleeping: SleepingTab | null, extra: Partial<TabRecord> = {}): TabRecord => ({ isDashboardTab: false, internalPage: null, pinned: false, sleeping, ...extra } as unknown as TabRecord)

describe('snapshotOf for a sleeping tab', () => {
  it('writes down the address and title it kept, not the blank view', () => {
    expect(snapshotOf(recordOf(asleep()), blank)).toEqual({ url: 'https://a.example/two', title: 'Two', pinned: false })
  })

  it('keeps the pin and the back and forward list, and never the page state', () => {
    const entries = [
      { url: 'https://a.example/one', title: 'One', pageState: 'form data' },
      { url: 'https://a.example/two', title: 'Two', pageState: 'more form data' }
    ]

    const snapshot = snapshotOf(recordOf(asleep({ entries, index: 1 }), { pinned: true }), blank)

    expect(snapshot).toEqual({
      url: 'https://a.example/two',
      title: 'Two',
      pinned: true,
      entries: [{ url: 'https://a.example/one', title: 'One' }, { url: 'https://a.example/two', title: 'Two' }],
      index: 1
    })
    expect(JSON.stringify(snapshot)).not.toContain('form data')
  })

  it('still writes the tab down when its view is gone', () => {
    expect(snapshotOf(recordOf(asleep()), destroyed)?.url).toBe('https://a.example/two')
  })

  it('refuses an address a tab would not open', () => {
    expect(snapshotOf(recordOf(asleep({ url: 'javascript:alert(1)' })), blank)).toBeNull()
  })

  it('reads the page as usual once the tab is awake', () => {
    const live = { ...blank, getURL: () => 'https://a.example/live', getTitle: () => 'Live' } as unknown as WebContents

    expect(snapshotOf(recordOf(null), live)).toEqual({ url: 'https://a.example/live', title: 'Live', pinned: false })
  })
})
