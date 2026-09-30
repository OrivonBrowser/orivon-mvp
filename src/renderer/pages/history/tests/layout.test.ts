import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '../../../../main/history/history-store.js'
import { buildLayout, visibleIds } from '../layout.js'

const at = (day: number, hour: number, minute = 0): number => new Date(2026, 8, day, hour, minute).getTime()
const entry = (id: number, lastVisit: number): HistoryEntry => ({ id, url: `https://s${String(id)}.example/`, title: `S${String(id)}`, lastVisit, visitCount: id })
const NOW = at(28, 16)
const base = { order: 'recent', grouping: 'day', collapsed: new Set<number>(), now: NOW, locale: 'en-US' } as const

// Newest first: two this afternoon, one this morning, one yesterday.
const ENTRIES = [entry(4, at(28, 15, 40)), entry(3, at(28, 15, 10)), entry(2, at(28, 9)), entry(1, at(27, 12))]

describe('buildLayout', () => {
  it('lays nothing out for no pages', () => {
    expect(buildLayout({ ...base, entries: [] })).toEqual([])
  })

  it('puts each day\'s pages in one run under its heading', () => {
    const sections = buildLayout({ ...base, entries: ENTRIES })
    expect(sections.map((section) => section.label)).toEqual(['Today', 'Yesterday'])
    expect(sections[0]?.blocks).toHaveLength(1)
    expect(sections[0]?.blocks[0]?.entries.map((each) => each.id)).toEqual([4, 3, 2])
    expect(sections[0]?.blocks[0]?.heading).toBeUndefined()
  })

  it('splits a day into sessions by gap, each with its heading and page count', () => {
    const sections = buildLayout({ ...base, grouping: 'session', entries: ENTRIES })
    const today = sections[0]?.blocks ?? []
    expect(today.map((block) => block.heading?.pages)).toEqual([2, 1])
    expect(today[0]?.heading?.label).toBe('Today, 3:10 PM to 3:40 PM')
    expect(today[1]?.heading?.label).toBe('Today, 9:00 AM')
    expect(sections[1]?.blocks[0]?.heading?.label).toBe('Yesterday, 12:00 PM')
  })

  it('files a session that crosses midnight under the day it ended', () => {
    const sections = buildLayout({ ...base, grouping: 'session', entries: [entry(2, at(28, 0, 10)), entry(1, at(27, 23, 50))] })
    expect(sections.map((section) => section.label)).toEqual(['Today'])
    expect(sections[0]?.blocks[0]?.heading?.label).toBe('Yesterday, 11:50 PM to Today, 12:10 AM')
  })

  it('is flat and headingless when sorted, whatever the grouping', () => {
    const sections = buildLayout({ ...base, order: 'visits', grouping: 'session', entries: ENTRIES })
    expect(sections).toHaveLength(1)
    expect(sections[0]?.label).toBe('')
    expect(sections[0]?.blocks[0]?.entries).toBe(ENTRIES)
  })

  it('marks a collapsed session, and the keys skip its rows', () => {
    const open = buildLayout({ ...base, grouping: 'session', entries: ENTRIES })
    const key = open[0]?.blocks[0]?.heading?.key as number
    const folded = buildLayout({ ...base, grouping: 'session', collapsed: new Set([key]), entries: ENTRIES })
    expect(folded[0]?.blocks[0]?.collapsed).toBe(true)
    expect(visibleIds(open)).toEqual([4, 3, 2, 1])
    expect(visibleIds(folded)).toEqual([2, 1])
  })
})
