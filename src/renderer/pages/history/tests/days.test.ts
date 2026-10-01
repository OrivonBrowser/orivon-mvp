import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '../../../../main/history/history-store.js'
import { dateTimeLabel, dayLabel, groupByDay } from '../days.js'

const at = (year: number, month: number, day: number, hour = 12): number => new Date(year, month - 1, day, hour).getTime()
const entry = (id: number, lastVisit: number): HistoryEntry => ({ id, url: `https://s${String(id)}.example/`, title: `S${String(id)}`, lastVisit, visitCount: 1 })

describe('dayLabel', () => {
  const now = at(2026, 9, 28, 9)

  it('says Today and Yesterday, by calendar day and not by how many hours ago', () => {
    expect(dayLabel(at(2026, 9, 28, 0), now, 'en-US')).toBe('Today')
    expect(dayLabel(at(2026, 9, 27, 23), now, 'en-US')).toBe('Yesterday')
    expect(dayLabel(at(2026, 9, 27, 0), now, 'en-US')).toBe('Yesterday')
    expect(dayLabel(at(2026, 9, 26, 23), now, 'en-US')).not.toBe('Yesterday')
  })

  it('names an earlier day, with the year only when it is not this one', () => {
    expect(dayLabel(at(2026, 9, 20), now, 'en-US')).toBe('Sunday, September 20')
    expect(dayLabel(at(2025, 12, 31), now, 'en-US')).toBe('Wednesday, December 31, 2025')
  })

  it('reads a time in the future as today', () => {
    expect(dayLabel(at(2026, 9, 30), now, 'en-US')).toBe('Today')
  })
})

describe('groupByDay', () => {
  it('groups consecutive entries of a day and keeps the order given', () => {
    const now = at(2026, 9, 28, 9)
    const groups = groupByDay([entry(1, at(2026, 9, 28, 8)), entry(2, at(2026, 9, 28, 1)), entry(3, at(2026, 9, 27, 20)), entry(4, at(2026, 9, 10))], now, 'en-US')
    expect(groups.map((group) => [group.label, group.entries.map((e) => e.id)])).toEqual([
      ['Today', [1, 2]],
      ['Yesterday', [3]],
      ['Thursday, September 10', [4]]
    ])
  })

  it('has no groups for no entries', () => {
    expect(groupByDay([], Date.now())).toEqual([])
  })
})

describe('dateTimeLabel', () => {
  const now = at(2026, 9, 28, 9)

  it('puts the time after Today and Yesterday', () => {
    expect(dateTimeLabel(at(2026, 9, 28, 3), now, 'en-US')).toBe('Today, 3:00 AM')
    expect(dateTimeLabel(at(2026, 9, 27, 21), now, 'en-US')).toBe('Yesterday, 9:00 PM')
  })

  it('gives an earlier day as a date and time, with the year only when it is not this one', () => {
    expect(dateTimeLabel(at(2026, 9, 11, 3), now, 'en-US')).toBe('Sep 11, 3:00 AM')
    expect(dateTimeLabel(at(2025, 12, 31, 21), now, 'en-US')).toBe('Dec 31, 2025, 9:00 PM')
  })
})
