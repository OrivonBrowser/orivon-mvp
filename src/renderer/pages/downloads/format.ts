// What the Downloads page says about a download, beyond what its bubble says too (shared/format-bytes.ts).
import type { DownloadEntry } from '../../../main/downloads/download-types.js'
import { dayLabel } from '../history/days.js'

export { fractionOf, formatBytes, formatSpeed, formatTimeLeft, reasonText, sourceLabel, statusLine } from '../shared/format-bytes.js'

export interface DayGroup<T> {
  readonly label: string
  readonly entries: readonly T[]
}

/** When a download belongs in the list: the day it started. Keeps the order it is given. */
export function groupByStartDay (entries: readonly DownloadEntry[], now: number, locale?: string): Array<DayGroup<DownloadEntry>> {
  const groups: Array<{ label: string, entries: DownloadEntry[] }> = []
  for (const entry of entries) {
    const label = dayLabel(entry.startedAt, now, locale)
    const last = groups.at(-1)
    if (last?.label === label) last.entries.push(entry)
    else groups.push({ label, entries: [entry] })
  }
  return groups
}
