// What one download is, as the service keeps it and as the Downloads page and the
// toolbar bubble read it. Plain data: no Electron, so it crosses to the renderer as a type.

/** Why a download did not finish. Chromium reports none of these; the service infers them (download-service.ts). */
export type DownloadReason = 'network' | 'server' | 'disk' | 'closed' | 'flood'

export type DownloadState = 'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted'

export interface DownloadEntry {
  readonly id: string
  /** The first address of the chain: what Retry asks for again. */
  readonly url: string
  /** The page the download started from, or an empty string when it started from no page. */
  readonly referrer: string
  readonly fileName: string
  /** Where the file is, or will be. Empty until a save dialog has been answered. Never sent by a page, only read from here. */
  readonly savePath: string
  readonly mime: string
  /** 0 when the server did not say. */
  readonly total: number
  readonly received: number
  readonly state: DownloadState
  readonly reason?: DownloadReason
  readonly startedAt: number
  readonly endedAt?: number
  /** A type that runs code: the file is never opened from Orivon. */
  readonly danger: boolean
  /** Complete, but the file is no longer on disk. Filled when the list is read. */
  readonly missing?: boolean
  /** Bytes per second, for a download in progress. */
  readonly speed?: number
}

export interface DownloadSummary {
  /** Downloads running or paused. */
  readonly active: number
  /** Share done (0 to 1) across the active downloads that know their size; null when none does. */
  readonly fraction: number | null
  /** Any download is listed at all. */
  readonly any: boolean
}

/** The entry that changed, or null when the list changed in a way that needs reading again. */
export type DownloadChange = DownloadEntry | null
