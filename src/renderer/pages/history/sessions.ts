// Consecutive pages visited close together form a session. Pure: computed from the pages a list has loaded, by
// each page's last visit, so a page visited in two sessions sits in its latest one.
import type { HistoryEntry } from '../../../main/history/history-store.js'
import { dayLabel, startOfDay, timeLabel } from './days.js'

export const SESSION_GAP_MS = 30 * 60_000

export interface Session {
  /** The oldest page's id: it stays the same while newer pages join the session, which a collapsed state needs. */
  readonly key: number
  /** The earliest and latest visit in it. */
  readonly start: number
  readonly end: number
  /** Newest first. */
  readonly entries: readonly HistoryEntry[]
}

/** `entries` are newest first. A gap of exactly `gapMs` still joins two pages. */
export function groupBySession (entries: readonly HistoryEntry[], gapMs: number = SESSION_GAP_MS): Session[] {
  const groups: HistoryEntry[][] = []
  for (const entry of entries) {
    const current = groups.at(-1)
    const previous = current?.at(-1)
    if (current !== undefined && previous !== undefined && previous.lastVisit - entry.lastVisit <= gapMs) current.push(entry)
    else groups.push([entry])
  }
  return groups.map((group) => {
    const newest = group[0] as HistoryEntry
    const oldest = group.at(-1) as HistoryEntry
    return { key: oldest.id, start: oldest.lastVisit, end: newest.lastVisit, entries: group }
  })
}

/** "Today, 2:05 PM to 3:40 PM"; a session that crosses midnight names both days. */
export function sessionLabel (session: Session, now: number, locale?: string): string {
  const endDay = dayLabel(session.end, now, locale)
  const from = timeLabel(session.start, locale)
  if (session.start === session.end) return `${endDay}, ${from}`
  if (startOfDay(session.start) === startOfDay(session.end)) return `${endDay}, ${from} to ${timeLabel(session.end, locale)}`
  return `${dayLabel(session.start, now, locale)}, ${from} to ${endDay}, ${timeLabel(session.end, locale)}`
}
