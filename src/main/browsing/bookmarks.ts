// The bookmarks bar's data model and disk persistence. Shaped like
// TabManager (tabs.ts) -- main holds truth, the chrome view only ever
// receives a pushed snapshot and issues commands, never derives state
// itself.
//
// Owner override, 2026-08-28 (scope.md, ADR-0003) -- bookmarks were
// not in the original scope pass; they arrived bundled with the chrome
// restyle. ADR-0003's storage table gained a fifth tier for this: plain
// JSON under <userData>, no safeStorage -- a bookmark list is not a
// secret.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { decodeDataUrl, sniffImageType } from './favicon-format.js'
import { MAX_FAVICON_BYTES } from './favicon.js'
import { sanitizeDirectUrl } from './omnibox.js'
import { DebouncedWriter } from '../storage/debounced-writer.js'

export { WRITE_DEBOUNCE_MS } from '../storage/debounced-writer.js'

export interface Bookmark {
  url: string
  title: string
  /** The site's own favicon as a `data:` URL, captured from the tab at the
   * moment it was starred (src/main/favicon.ts already fetched and re-encoded
   * it for the tab strip). Stored with the bookmark rather than re-fetched:
   * the bookmarks bar must render instantly and offline, and a privileged
   * view making a network request for an icon is exactly what favicon.ts
   * exists to avoid. `null` for a bookmark starred before its favicon
   * arrived, or from before this field existed -- the bar falls back to the
   * generic globe. */
  favicon: string | null
}

/** What a caller hands `BookmarkStore.add` -- the icon is optional there, and
 * normalised to `null` on the way in. */
export interface BookmarkInput {
  url: string
  title: string
  favicon?: string | null
}

/** A stored favicon is only ever a `data:` image, capped at the same size
 * favicon.ts enforces on the wire (`MAX_FAVICON_BYTES`), derived rather than
 * a second literal (code-guidelines.md Rule 3) -- base64's ~4/3 expansion
 * plus a little slack for the media-type prefix.
 *
 * This runs on LOAD, not just on write, for the same reason `sanitizeDirectUrl`
 * does: `bookmarks.json` is a plain user-writable file, so anything in it is
 * untrusted input to a privileged view. A `data:text/html` here could not
 * execute -- the chrome view's CSP is `img-src 'self' data:` and this only
 * ever becomes an `<img>` -- but persisting unbounded attacker-chosen bytes
 * into a file the shell reads at startup is not a thing to allow on the
 * grounds that the next layer would probably catch it. The prefix and size
 * checks alone would accept anything merely LABELLED `image/*`, so the
 * payload is decoded and sniffed too (favicon-format.ts's own byte check,
 * the same one a fetched candidate goes through) -- a stored favicon is
 * exactly as untrusted as a page's own `<link rel=icon>`, and gets exactly
 * the same guarantee: what it renders as is decided by its bytes, not by
 * a label anything wrote into the file. */
export const MAX_STORED_FAVICON_CHARS = Math.ceil(MAX_FAVICON_BYTES * 4 / 3) + 64

export function sanitizeStoredFavicon (value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (!value.startsWith('data:image/')) return null
  if (value.length > MAX_STORED_FAVICON_CHARS) return null
  const bytes = decodeDataUrl(value, MAX_FAVICON_BYTES)
  if (bytes === null || sniffImageType(bytes) === null) return null
  return value
}

/** Adds `entry`, replacing any existing bookmark for the same URL rather
 * than duplicating it. The replaced (or new) entry moves to the end, so
 * re-starring a page brings it back to where a user would expect to find
 * the thing they just did. Pure -- no I/O, so it is testable on its own. */
export function addBookmark (list: readonly Bookmark[], entry: Bookmark): Bookmark[] {
  return [...list.filter((b) => b.url !== entry.url), entry]
}

export function removeBookmark (list: readonly Bookmark[], url: string): Bookmark[] {
  return list.filter((b) => b.url !== url)
}

export function hasBookmark (list: readonly Bookmark[], url: string): boolean {
  return list.some((b) => b.url === url)
}

/** Parses the on-disk JSON, dropping anything malformed instead of
 * throwing -- a corrupt bookmarks file must never stop the browser from
 * starting (see BookmarkStore.load). Every URL is re-validated through
 * `sanitizeDirectUrl`: the file is user-writable, and a stored
 * `javascript:` URL would be persisted XSS into this privileged view,
 * the same reasoning omnibox.ts already applies to typed input. */
export function parseBookmarksFile (raw: string): Bookmark[] {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []

  const result: Bookmark[] = []
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue
    const { url, title, favicon } = entry as Record<string, unknown>
    if (typeof url !== 'string' || typeof title !== 'string') continue
    const safeUrl = sanitizeDirectUrl(url)
    if (safeUrl === null) continue
    // A rejected favicon drops the ICON, never the bookmark -- losing a
    // page someone saved because its icon was malformed would be a far
    // worse failure than showing the globe.
    result.push({ url: safeUrl, title, favicon: sanitizeStoredFavicon(favicon) })
  }
  return result
}

export function serializeBookmarksFile (list: readonly Bookmark[]): string {
  return JSON.stringify(list, null, 2)
}

export class BookmarkStore {
  private list: Bookmark[] = []
  private loading: Promise<void> | null = null
  private readonly listeners = new Set<() => void>()
  private readonly writer = new DebouncedWriter(async () => { await this.writeNow() })

  constructor (private readonly filePath: string) {}

  /** Reads the file once, however many windows ask: a second read would
   * replace the list with what is on disk and drop any change not yet
   * flushed. Any failure -- missing (first launch), unreadable, or
   * corrupt -- yields an empty list rather than throwing: a browser that
   * refuses to start because its bookmarks file is damaged is a worse
   * failure than one that lost them. */
  load (): Promise<void> {
    this.loading ??= this.readFromDisk()
    return this.loading
  }

  private async readFromDisk (): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      this.list = parseBookmarksFile(raw)
    } catch {
      this.list = []
    }
  }

  getAll (): Bookmark[] {
    return this.list
  }

  has (url: string): boolean {
    return hasBookmark(this.list, url)
  }

  /** `favicon` is optional because a caller may genuinely not have one yet
   * -- a page starred before its icon finished loading. It is sanitized on
   * the way in as well as on the way out (parseBookmarksFile): this value
   * reaches here from a tab's captured favicon, and the store should not
   * depend on every future caller having checked it first. */
  add (entry: BookmarkInput): void {
    const safeUrl = sanitizeDirectUrl(entry.url)
    if (safeUrl === null) return
    this.list = addBookmark(this.list, {
      url: safeUrl,
      title: entry.title,
      favicon: sanitizeStoredFavicon(entry.favicon)
    })
    this.emitChange()
  }

  /** Fills in the icon for an ALREADY-saved bookmark, and reports whether
   * anything changed. Deliberately does NOT notify `onChange` listeners, only
   * schedules the disk write: its one caller is window.ts's pushState, which
   * is about to send the whole list anyway, and emitting there would push
   * state from inside a state push. Never overwrites an icon that is already
   * set -- the stored one came from the page at the moment it was starred,
   * which is the one the user actually chose to keep. */
  fillMissingFavicon (url: string, favicon: string): boolean {
    const safe = sanitizeStoredFavicon(favicon)
    if (safe === null) return false
    const existing = this.list.find((b) => b.url === url)
    if (existing === undefined || existing.favicon !== null) return false
    this.list = this.list.map((b) => (b.url === url ? { ...b, favicon: safe } : b))
    this.writer.schedule()
    return true
  }

  remove (url: string): void {
    this.list = removeBookmark(this.list, url)
    this.emitChange()
  }

  /** Returns the removal: a window that closes must stop listening, or the
   * next change made in another window calls into the closed one. */
  onChange (cb: () => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  /** Resolves once the on-disk file reflects every change made up to this
   * call, and rejects with the write's error if that write failed -- see
   * DebouncedWriter.flush. Exists for tests and for the quit-time flush in
   * index.ts: waiting on the real write, instead of a guessed delay, is what
   * makes the debounce test's timing deterministic and what lets quit wait
   * for a genuine "safe to exit" signal. */
  async flushPendingWrite (): Promise<void> {
    await this.writer.flush()
  }

  private emitChange (): void {
    for (const listener of this.listeners) listener()
    this.writer.schedule()
  }

  private async writeNow (): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(this.filePath, serializeBookmarksFile(this.list), 'utf8')
    } catch (error) {
      // Loud, never silent -- same policy index.ts applies to subsystem
      // failures. Losing a write is recoverable; hiding it is not.
      console.error('[orivon] failed to persist bookmarks:', error)
      // Re-thrown so the writer learns the write failed and flush() rejects
      // instead of reporting a failed write as though it landed.
      throw error
    }
  }
}
