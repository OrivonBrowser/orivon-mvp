// The bookmarks bar's data model and disk persistence. Shaped like
// TabManager (tabs.ts) -- main holds truth, the chrome view only ever
// receives a pushed snapshot and issues commands, never derives state
// itself.
//
// Owner override, 2026-08-28 (mvp-scope.md, ADR-0003) -- bookmarks were
// not in the original scope pass; they arrived bundled with the chrome
// restyle. ADR-0003's storage table gained a fifth tier for this: plain
// JSON under <userData>, no safeStorage -- a bookmark list is not a
// secret.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { sanitizeDirectUrl } from './omnibox.js'

export interface Bookmark {
  url: string
  title: string
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
    const { url, title } = entry as Record<string, unknown>
    if (typeof url !== 'string' || typeof title !== 'string') continue
    const safeUrl = sanitizeDirectUrl(url)
    if (safeUrl === null) continue
    result.push({ url: safeUrl, title })
  }
  return result
}

export function serializeBookmarksFile (list: readonly Bookmark[]): string {
  return JSON.stringify(list, null, 2)
}

/** Batches rapid star/unstar clicks into one write instead of one per
 * click. */
export const WRITE_DEBOUNCE_MS = 300

export class BookmarkStore {
  private list: Bookmark[] = []
  private readonly listeners = new Set<() => void>()
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private pendingWrite: Promise<void> | null = null
  private resolvePendingWrite: (() => void) | null = null

  constructor (private readonly filePath: string) {}

  /** Reads the file once at startup. Any failure -- missing (first
   * launch), unreadable, or corrupt -- yields an empty list rather than
   * throwing: a browser that refuses to start because its bookmarks file
   * is damaged is a worse failure than one that lost them. */
  async load (): Promise<void> {
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

  add (entry: Bookmark): void {
    const safeUrl = sanitizeDirectUrl(entry.url)
    if (safeUrl === null) return
    this.list = addBookmark(this.list, { url: safeUrl, title: entry.title })
    this.emitChange()
  }

  remove (url: string): void {
    this.list = removeBookmark(this.list, url)
    this.emitChange()
  }

  onChange (cb: () => void): void {
    this.listeners.add(cb)
  }

  /** Resolves once every write scheduled up to this call has landed on
   * disk -- one still inside its debounce window, one already in flight, or
   * a chain of both if more changes arrive while it waits. Resolves right
   * away, without throwing, when nothing is pending. `writeNow` never
   * rejects (see below), so this never does either. Exists for tests:
   * waiting on the real write, instead of a guessed delay, is what makes
   * the debounce test's timing deterministic. */
  async flushPendingWrite (): Promise<void> {
    await this.pendingWrite
  }

  private emitChange (): void {
    for (const listener of this.listeners) listener()
    this.scheduleWrite()
  }

  /** Debounces bursts of changes into one write. `pendingWrite` is created
   * once per burst and reused across however many times the timer below
   * gets reset, rather than replaced on each change -- otherwise a caller
   * already awaiting an earlier promise would be left awaiting one that
   * `clearTimeout` just cancelled the only resolver for, and it would never
   * settle. See `settleWrite` for the other half: what stops it from
   * resolving too early when a change arrives while the write is already
   * running, past the point `clearTimeout` can still help. */
  private scheduleWrite (): void {
    if (this.writeTimer !== null) clearTimeout(this.writeTimer)
    if (this.pendingWrite === null) {
      this.pendingWrite = new Promise((resolve) => {
        this.resolvePendingWrite = resolve
      })
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      void this.writeNow().finally(() => this.settleWrite())
    }, WRITE_DEBOUNCE_MS)
  }

  /** Runs after a write finishes. If a change arrived while it was running,
   * `scheduleWrite` already queued a fresh timer for it -- leave
   * `pendingWrite` as is, so a caller awaiting it keeps waiting for the
   * write that change is going to produce, instead of being told the data
   * is on disk before it actually is. Otherwise this is the last write in
   * the burst: resolve, and clear both fields so the next change starts a
   * new promise rather than reusing this already-settled one. */
  private settleWrite (): void {
    if (this.writeTimer !== null) return
    const resolve = this.resolvePendingWrite
    this.pendingWrite = null
    this.resolvePendingWrite = null
    if (resolve !== null) resolve()
  }

  private async writeNow (): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(this.filePath, serializeBookmarksFile(this.list), 'utf8')
    } catch (error) {
      // Loud, never silent -- same policy index.ts applies to subsystem
      // failures. Losing a write is recoverable; hiding it is not.
      console.error('[orivon] failed to persist bookmarks:', error)
    }
  }
}
