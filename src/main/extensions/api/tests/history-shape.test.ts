import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '../../../history/history-store.js'
import { DAY_MS, diffHistory, searchWindow, timeOf, toHistoryItem, toVisitItem } from '../history-shape.js'

const entry = (id: number, lastVisit: number, visitCount = 1, url = `https://p${String(id)}.test/`): HistoryEntry => ({ id, url, title: `T${String(id)}`, lastVisit, visitCount })
const known = (...entries: HistoryEntry[]): Map<number, HistoryEntry> => new Map(entries.map((e) => [e.id, e]))

describe('items', () => {
  it('shapes a page as a HistoryItem with a string id', () => {
    expect(toHistoryItem(entry(7, 500, 3))).toEqual({ id: '7', url: 'https://p7.test/', title: 'T7', lastVisitTime: 500, visitCount: 3, typedCount: 0 })
  })

  it('stands one visit for the one row kept per address', () => {
    expect(toVisitItem(entry(7, 500))).toEqual({ id: '7', visitId: '7', visitTime: 500, referringVisitId: '0', transition: 'link', isLocal: true })
  })
})

describe('timeOf', () => {
  it('takes milliseconds or a Date, nothing else', () => {
    expect(timeOf(5, 't')).toBe(5)
    expect(timeOf(new Date(9), 't')).toBe(9)
    for (const bad of ['5', null, NaN, Infinity, {}]) expect(() => timeOf(bad, 't')).toThrow('Invalid argument: t')
  })
})

describe('searchWindow', () => {
  it('defaults to the last 24 hours, no end, 100 rows', () => {
    expect(searchWindow({ text: '' }, 10 * DAY_MS)).toEqual({ text: '', from: 9 * DAY_MS, to: Number.MAX_SAFE_INTEGER, limit: 100 })
    expect(searchWindow({}, 10 * DAY_MS).text).toBe('')
  })

  it('takes the named window and clamps the row count to 1..1000', () => {
    expect(searchWindow({ text: 'a', startTime: 1, endTime: 2, maxResults: 5 }, 0)).toEqual({ text: 'a', from: 1, to: 2, limit: 5 })
    expect(searchWindow({ maxResults: 0 }, 0).limit).toBe(1)
    expect(searchWindow({ maxResults: 99999 }, 0).limit).toBe(1000)
    expect(searchWindow({ maxResults: 2.9 }, 0).limit).toBe(2)
  })

  it('rejects a query that is not an object and fields of the wrong type', () => {
    for (const bad of [null, 'x', [], { text: 5 }, { maxResults: 'x' }, { startTime: 'x' }]) expect(() => searchWindow(bad, 0)).toThrow('Invalid argument')
  })
})

describe('diffHistory', () => {
  it('reports a new page and a page visited again, oldest first', () => {
    const before = known(entry(1, 100), entry(2, 200))
    const fresh = [entry(3, 400), entry(1, 300, 2), entry(2, 200)]
    expect(diffHistory(before, fresh).map((event) => event.type === 'visited' ? event.item.id : 'x')).toEqual(['1', '3'])
  })

  it('reports a page that went while it was among the newest', () => {
    const before = known(entry(1, 100), entry(2, 200))
    expect(diffHistory(before, [entry(2, 200)])).toEqual([{ type: 'removed', allHistory: false, urls: ['https://p1.test/'] }])
  })

  it('does not call a page removed when newer pages pushed it out of a full window', () => {
    const before = known(entry(1, 100), entry(2, 200))
    expect(diffHistory(before, [entry(3, 300), entry(2, 200)], 2)).toEqual([{ type: 'visited', item: expect.objectContaining({ id: '3' }) }])
  })

  it('says allHistory when nothing is left', () => {
    expect(diffHistory(known(entry(1, 100)), [])).toEqual([{ type: 'removed', allHistory: true, urls: [] }])
  })

  it('reports nothing for a change that is only a title', () => {
    expect(diffHistory(known(entry(1, 100)), [{ ...entry(1, 100), title: 'later' }])).toEqual([])
  })
})
