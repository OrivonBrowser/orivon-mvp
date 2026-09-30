// Puts a list of pages, newest first, under a heading for the day each was
// last visited. Pure: the current time is passed in, and the days are the
// reader's own local days.
import type { HistoryEntry } from '../../../main/history/history-store.js'

export interface DayGroup {
  readonly label: string
  readonly entries: readonly HistoryEntry[]
}

export const startOfDay = (time: number): number => {
  const date = new Date(time)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export function dayLabel (time: number, now: number, locale?: string): string {
  const today = startOfDay(now)
  const day = startOfDay(time)
  // Whole calendar days, counted so a day of 23 or 25 hours does not miscount.
  const daysAgo = Math.round((today - day) / 86_400_000)
  if (daysAgo <= 0) return 'Today'
  if (daysAgo === 1) return 'Yesterday'
  const sameYear = new Date(time).getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) }).format(time)
}

/** Keeps the order it is given: consecutive entries of one day share a group. */
export function groupByDay (entries: readonly HistoryEntry[], now: number, locale?: string): DayGroup[] {
  const groups: Array<{ label: string, entries: HistoryEntry[] }> = []
  for (const entry of entries) {
    const label = dayLabel(entry.lastVisit, now, locale)
    const last = groups.at(-1)
    if (last?.label === label) last.entries.push(entry)
    else groups.push({ label, entries: [entry] })
  }
  return groups
}

export function timeLabel (time: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(time)
}
