import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '../../../../main/history/history-store.js'
import { SESSION_GAP_MS, groupBySession, sessionLabel } from '../sessions.js'

const MIN = 60_000
const at = (day: number, hour: number, minute = 0): number => new Date(2026, 8, day, hour, minute).getTime()
const entry = (id: number, lastVisit: number): HistoryEntry => ({ id, url: `https://s${String(id)}.example/`, title: `S${String(id)}`, lastVisit, visitCount: 1 })

describe('groupBySession', () => {
  it('is empty for no pages, and one session for a single page', () => {
    expect(groupBySession([])).toEqual([])
    const [only] = groupBySession([entry(1, 5000)])
    expect(only).toMatchObject({ key: 1, start: 5000, end: 5000 })
    expect(only?.entries).toHaveLength(1)
  })

  it('keeps pages exactly thirty minutes apart together, and splits at one millisecond more', () => {
    const joined = groupBySession([entry(2, 100 * MIN), entry(1, 100 * MIN - SESSION_GAP_MS)])
    expect(joined).toHaveLength(1)
    const split = groupBySession([entry(2, 100 * MIN + 1), entry(1, 100 * MIN - SESSION_GAP_MS)])
    expect(split).toHaveLength(2)
  })

  it('chains pages: each is measured from the one before it, not from the session\'s start', () => {
    const [session, ...rest] = groupBySession([entry(4, 90 * MIN), entry(3, 60 * MIN), entry(2, 30 * MIN), entry(1, 0)])
    expect(rest).toEqual([])
    expect(session).toMatchObject({ start: 0, end: 90 * MIN, key: 1 })
    expect(session?.entries.map((each) => each.id)).toEqual([4, 3, 2, 1])
  })

  it('does not split a session at midnight', () => {
    const sessions = groupBySession([entry(2, at(28, 0, 10)), entry(1, at(27, 23, 50))])
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ start: at(27, 23, 50), end: at(28, 0, 10) })
  })

  it('numbers each session by its oldest page, so the key holds while newer pages join', () => {
    const before = groupBySession([entry(2, 10 * MIN), entry(1, 0)])[0]
    const after = groupBySession([entry(3, 20 * MIN), entry(2, 10 * MIN), entry(1, 0)])[0]
    expect(before?.key).toBe(after?.key)
  })
})

describe('sessionLabel', () => {
  const now = at(28, 16)
  const session = (start: number, end: number) => ({ key: 1, start, end, entries: [entry(1, end)] })

  it('names both times of a session, not its day', () => {
    expect(sessionLabel(session(at(28, 14, 5), at(28, 15, 40)), now, 'en-US')).toBe('2:05 PM to 3:40 PM')
  })

  it('names one time for a session of a single moment', () => {
    expect(sessionLabel(session(at(27, 9), at(27, 9)), now, 'en-US')).toBe('9:00 AM')
  })

  it('names the earlier day when it crosses midnight', () => {
    expect(sessionLabel(session(at(27, 23, 50), at(28, 0, 20)), now, 'en-US')).toBe('Yesterday, 11:50 PM to 12:20 AM')
  })
})
