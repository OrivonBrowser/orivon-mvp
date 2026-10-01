// What a download's row says, for the Downloads page and the toolbar bubble alike. Pure: the entry is passed
// in, so every string a row can show is tested without a document.
import type { DownloadEntry, DownloadReason } from '../../../main/downloads/download-types.js'

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** `12.4 MB`, `200 KB`, `64 MB`: binary units, a decimal only below 10 and only when it is not zero, none for plain bytes. */
export function formatBytes (bytes: number): string {
  let value = Math.max(0, bytes)
  let unit = 0
  while ((value >= 1024 || (unit > 0 && Math.round(value) >= 1024)) && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  if (unit === 0) return `${String(Math.round(value))} B`
  const text = value < 10 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value))
  return `${text} ${UNITS[unit] ?? 'TB'}`
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

/** The running line of the toolbar bubble, which is narrower than a page row: how far and how long, without the speed. */
export function compactProgressLine (entry: DownloadEntry): string {
  const speed = entry.speed ?? 0
  const done = entry.total > 0 ? `${formatBytes(entry.received)} / ${formatBytes(entry.total)}` : formatBytes(entry.received)
  return speed > 0 && entry.total > entry.received ? `${done} · ${formatTimeLeft((entry.total - entry.received) / speed)}` : done
}

/** The line under a row's source: how far it is, or how it ended. A failed row's reason is its badge, not this line. */
export function statusLine (entry: DownloadEntry): string {
  switch (entry.state) {
    case 'progressing': {
      const speed = entry.speed ?? 0
      const parts = [progressOf(entry)]
      if (speed > 0) parts.push(formatSpeed(speed))
      if (speed > 0 && entry.total > entry.received) parts.push(formatTimeLeft((entry.total - entry.received) / speed))
      return parts.join(' · ')
    }
    case 'paused': return `Paused · ${progressOf(entry)}`
    case 'held': return 'This type of file can harm your computer.'
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
