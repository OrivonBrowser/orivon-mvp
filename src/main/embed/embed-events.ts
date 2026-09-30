// What the app is told about a window a shown page asked for and a download
// it started (ADR-0047), built from what Electron reports, with no
// `electron` import so it runs under plain vitest. ./embed-host.ts reads the
// raw values and sends what these return.

import { LIMITS } from '../../contracts/index.js'
import type { EmbedDownload, EmbedPopup } from '../../contracts/index.js'

/** The `HandlerDetails` fields a popup notice reads. */
export interface RawWindowOpen {
  readonly url: string
  readonly frameName: string
  readonly disposition: string
  readonly referrer?: { readonly url?: string } | undefined
  /** Present exactly when the page posted a form to the new window. */
  readonly postBody?: unknown
}

/** The `DownloadItem` fields a download notice reads. */
export interface RawDownload {
  /** Every address the item passed through, the first the one asked for. */
  readonly urlChain: readonly string[]
  readonly filename: string
  readonly mimeType: string
  readonly totalBytes: number
}

const DISPOSITIONS: ReadonlySet<string> = new Set(['default', 'foreground-tab', 'background-tab', 'new-window'])

/** An address as the app is told it: the address itself, or `''` past `LIMITS.embedEventUrlBytes` UTF-8 bytes. */
export function boundedAddress (url: string): string {
  return Buffer.byteLength(url, 'utf8') > LIMITS.embedEventUrlBytes ? '' : url
}

/** The most UTF-8 bytes a frame name, a file name or a MIME type may carry in a notice; longer arrives as `''`. */
export const NOTICE_TEXT_BYTES = 4096

/** Text a shown page chose, as the app is told it: itself, or `''` past `NOTICE_TEXT_BYTES` UTF-8 bytes. */
export function boundedText (text: string): string {
  return Buffer.byteLength(text, 'utf8') > NOTICE_TEXT_BYTES ? '' : text
}

/** A file name with any directory part removed, whichever separator it used; `''` when nothing but a directory is left. */
export function bareFileName (name: string): string {
  const bare = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
  return bare === '.' || bare === '..' ? '' : bare
}

export function popupDetail (raw: RawWindowOpen): EmbedPopup {
  return {
    url: boundedAddress(raw.url),
    disposition: DISPOSITIONS.has(raw.disposition) ? raw.disposition as EmbedPopup['disposition'] : 'other',
    frameName: typeof raw.frameName === 'string' ? boundedText(raw.frameName) : '',
    referrer: typeof raw.referrer?.url === 'string' ? boundedAddress(raw.referrer.url) : '',
    method: raw.postBody === undefined || raw.postBody === null ? 'GET' : 'POST'
  }
}

export function downloadDetail (raw: RawDownload): EmbedDownload {
  const final = raw.urlChain[raw.urlChain.length - 1] ?? ''
  return {
    url: boundedAddress(final),
    filename: boundedText(bareFileName(raw.filename)),
    mimeType: boundedText(raw.mimeType),
    totalBytes: Number.isFinite(raw.totalBytes) && raw.totalBytes > 0 ? raw.totalBytes : 0
  }
}

/** How many notices one shown page may send its app within a second; the rest are dropped. */
export const NOTICES_PER_SECOND = 20

/**
 * A shown page chooses when it asks for a window, so nothing else stops it
 * telling its app of thousands a second, each carrying an address up to
 * `LIMITS.embedEventUrlBytes`. One of these per shown page lets
 * `NOTICES_PER_SECOND` through in each second and refuses the rest. The
 * window is denied and the download cancelled whatever this answers.
 */
export function createNoticeBudget (now: () => number = Date.now): () => boolean {
  let windowStart = Number.NEGATIVE_INFINITY
  let used = 0
  return () => {
    const at = now()
    if (at - windowStart >= 1000) {
      windowStart = at
      used = 0
    }
    if (used >= NOTICES_PER_SECOND) return false
    used += 1
    return true
  }
}
