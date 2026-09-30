import { describe, expect, it } from 'vitest'
import type { SearchClosedRow, SearchRow, SearchTabRow } from '../../main/tab-search/tab-search-model.js'
import { agoText, countLine, flatten, groupsFor, keyOf, move, PAGE_STEP, reconcile, titleOf } from '../overlay/tab-search/list-model.js'

const tab = (id: string, title: string, extra: Partial<SearchTabRow> = {}): SearchTabRow => ({ kind: 'tab', id, windowKey: 1, title, host: `${id}.example.com`, favicon: null, isNewTab: false, pinned: false, audible: false, muted: false, current: false, otherWindow: null, ...extra })
const closed = (entryId: number, title: string): SearchClosedRow => ({ kind: 'closed', entryId, title, host: 'gone.example', at: 0, count: 1, window: false })

const rows: SearchRow[] = [tab('a', 'Alpha report'), tab('b', 'Beta notes'), tab('g', 'Gamma'), closed(1, 'Delta gone')]

describe('groupsFor', () => {
  it('gives the rows in main\'s order under their two labels when nothing is typed', () => {
    const groups = groupsFor(rows, '')
    expect(groups.map((group) => group.label)).toEqual(['Open tabs', 'Recently closed'])
    expect(groups.map((group) => group.items.map((item) => item.key))).toEqual([['tab:a', 'tab:b', 'tab:g'], ['closed:1']])
  })

  it('drops a group with nothing in it, label and all', () => {
    expect(groupsFor(rows, 'delta').map((group) => group.label)).toEqual(['Recently closed'])
    expect(groupsFor(rows, 'zzz')).toEqual([])
  })

  it('ranks each group by how well it matches and keeps main\'s order for equal matches', () => {
    const list: SearchRow[] = [tab('a', 'Xbeta'), tab('b', 'Beta one'), tab('c', 'Beta two')]
    expect(flatten(groupsFor(list, 'beta')).map((item) => item.key)).toEqual(['tab:b', 'tab:c', 'tab:a'])
  })

  it('carries the ranges to highlight', () => {
    const [group] = groupsFor(rows, 'bet')
    expect(group?.items[0]).toMatchObject({ key: 'tab:b', titleRanges: [[0, 3]] })
  })

  it('leaves out rows the person has just closed', () => {
    expect(flatten(groupsFor(rows, '', new Set(['tab:b']))).map((item) => item.key)).toEqual(['tab:a', 'tab:g', 'closed:1'])
  })

  it('reads the new-tab page as "New tab" and a blank title as its address', () => {
    expect(titleOf(tab('n', '', { isNewTab: true }))).toBe('New tab')
    expect(titleOf(tab('n', '', { host: 'bare.example' }))).toBe('bare.example')
    expect(titleOf(tab('n', '', { host: '' }))).toBe('Untitled')
  })
})

describe('move', () => {
  const keys = ['a', 'b', 'c']

  it('steps and wraps round the ends for the arrow keys', () => {
    expect(move(keys, 'a', 1, true)).toBe('b')
    expect(move(keys, 'c', 1, true)).toBe('a')
    expect(move(keys, 'a', -1, true)).toBe('c')
  })

  it('stops at the ends when paging', () => {
    expect(move(keys, 'a', PAGE_STEP, false)).toBe('c')
    expect(move(keys, 'c', -PAGE_STEP, false)).toBe('a')
  })

  it('starts from the first row going down and the last going up when nothing is selected', () => {
    expect(move(keys, null, 1, true)).toBe('a')
    expect(move(keys, null, -1, true)).toBe('c')
    expect(move(keys, 'gone', 1, true)).toBe('a')
  })

  it('has nowhere to go in an empty list', () => {
    expect(move([], null, 1, true)).toBeNull()
  })
})

describe('reconcile', () => {
  it('keeps the selected row when an update still has it, wherever it moved', () => {
    expect(reconcile(['a', 'b', 'c'], 'b', ['c', 'b', 'a'])).toBe('b')
  })

  it('takes the row that took the place of one that went', () => {
    expect(reconcile(['a', 'b', 'c'], 'b', ['a', 'c'])).toBe('c')
  })

  it('takes the last row when the last one went', () => {
    expect(reconcile(['a', 'b', 'c'], 'c', ['a', 'b'])).toBe('b')
  })

  it('selects the first row when nothing was selected, and nothing when nothing is left', () => {
    expect(reconcile([], null, ['a', 'b'])).toBe('a')
    expect(reconcile(['a'], 'a', [])).toBeNull()
  })
})

describe('countLine', () => {
  it('counts the open tabs, and the windows when there is more than one', () => {
    expect(countLine([tab('a', 'A'), closed(1, 'C')])).toBe('1 tab')
    expect(countLine([tab('a', 'A'), tab('b', 'B')])).toBe('2 tabs')
    expect(countLine([tab('a', 'A'), tab('b', 'B', { windowKey: 2 })])).toBe('2 tabs in 2 windows')
    expect(countLine([])).toBe('0 tabs')
  })
})

describe('agoText', () => {
  const now = 10_000_000_000
  it('says how long ago in the shortest usable unit', () => {
    expect(agoText(now - 5_000, now)).toBe('just now')
    expect(agoText(now - 2 * 60_000, now)).toBe('2 min ago')
    expect(agoText(now - 3 * 3_600_000, now)).toMatch(/^3 hr ago$/)
    expect(agoText(now - 2 * 86_400_000, now)).toMatch(/^2 days ago$/)
  })

  it('is never negative', () => {
    expect(agoText(now + 5000, now)).toBe('just now')
  })
})

describe('keyOf', () => {
  it('tells an open tab from a closed entry that shares its number', () => {
    expect(keyOf(tab('1', 'x'))).not.toBe(keyOf(closed(1, 'x')))
  })
})
