// What the Downloads page says about a download. Pure: the current time and the entry are passed in, so
// every string a row can show is tested without a document.
import type { DownloadEntry, DownloadReason } from '../../../main/downloads/download-types.js'
import { dayLabel } from '../history/days.js'

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** `12.4 MB`: binary units with one decimal, none for plain bytes. */
export function formatBytes (bytes: number): string {
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return unit === 0 ? `${String(Math.round(value))} B` : `${value.toFixed(1)} ${UNITS[unit] ?? 'TB'}`
}

export function formatSpeed (bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}

/** `30 s left`, `4 min left`, `1 h 5 min left`. */
export function formatTimeLeft (seconds: number): string {
  const whole = Math.max(1, Math.ceil(seconds))
  if (whole < 60) return `${String(whole)} s left`
  const minutes = Math.ceil(whole / 60)
  if (minutes < 60) return `${String(minutes)} min left`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${String(hours)} h left` : `${String(hours)} h ${String(rest)} min left`
}

const REASONS: Readonly<Record<DownloadReason, string>> = {
  network: 'Network error',
  server: 'The server stopped the download',
  disk: 'Disk full or no permission',
  closed: 'Orivon closed before it finished',
  flood: 'Too many downloads from this site'
}

export function reasonText (reason: DownloadReason | undefined): string {
  return reason === undefined ? REASONS.network : REASONS[reason]
}

/** The share done (0 to 1), or null when the size is not known. */
export function fractionOf (entry: Pick<DownloadEntry, 'received' | 'total'>): number | null {
  return entry.total > 0 ? Math.min(1, entry.received / entry.total) : null
}

const progressOf = (entry: DownloadEntry): string => entry.total > 0 ? `${formatBytes(entry.received)} of ${formatBytes(entry.total)}` : formatBytes(entry.received)

/** The line under a row's source: how far it is, or how it ended. A failed row's reason is its badge, not this line. */
export function statusLine (entry: DownloadEntry): string {
  switch (entry.state) {
    case 'progressing': {
      const speed = entry.speed ?? 0
      const parts = [progressOf(entry)]
      if (speed > 0) parts.push(formatSpeed(speed))
      if (speed > 0 && entry.total > entry.received) parts.push(formatTimeLeft((entry.total - entry.received) / speed))
      return parts.join(', ')
    }
    case 'paused': return `Paused, ${progressOf(entry)}`
    case 'completed': return entry.missing === true ? 'Moved or deleted' : formatBytes(entry.total > 0 ? entry.total : entry.received)
    case 'cancelled': return 'Cancelled'
    case 'interrupted': return ''
  }
}

/** The address a file came from, short: its host, or the scheme for one that has none. */
export function sourceLabel (url: string): string {
  try {
    const { hostname, protocol } = new URL(url)
    return hostname === '' ? protocol : hostname
  } catch {
    return url
  }
}

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
