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
  // Every BookmarkStore ever constructed, for BookmarkStore.flushAll() --
  // index.ts's quit path needs to flush every window's store and has no
  // reference to any of them (each is a local inside window.ts's
  // createShellWindow()); self-registration here is simpler than plumbing
  // one through, and a closed window's store just becomes a permanent
  // no-op flush (nothing left to write), which costs nothing to keep.
  private static readonly instances = new Set<BookmarkStore>()

  private list: Bookmark[] = []
  private readonly listeners = new Set<() => void>()
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private pendingWrite: Promise<void> | null = null
  private resolvePendingWrite: (() => void) | null = null
  private rejectPendingWrite: ((error: unknown) => void) | null = null
  // At most one writeNow() may run at a time -- see scheduleWrite/runWrite.
  private writeInFlight = false
  // Set when the list changes again while a write is already running, so
  // that write's completion starts another pass over the now-current list
  // instead of the caller starting a second, concurrent writeNow().
  private rerunRequested = false

  constructor (private readonly filePath: string) {
    BookmarkStore.instances.add(this)
  }

  /** Flushes every BookmarkStore constructed so far. Never rejects --
   * a store whose write failed is reported via console.error inside
   * writeNow already, and one slow or failed store must not stop this
   * from settling for the others. Callers that need a bound on how long
   * this can take (e.g. before quitting) must apply their own timeout;
   * this makes no promise about how long a write in flight can take. */
  static async flushAll (): Promise<void> {
    await Promise.allSettled([...BookmarkStore.instances].map((store) => store.flushPendingWrite()))
  }

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

  /** Resolves once the on-disk file reflects every change made up to this
   * call -- through the debounce window, through a write already in
   * flight, and through any further write that in-flight write's
   * completion triggers because the list changed again while it ran (see
   * runWrite). At most one writeNow() is ever running at a time, so there
   * is exactly one write left to wait for, never two racing to land in
   * whichever order the disk happens to finish them.
   *
   * Rejects with whatever writeNow's write threw if the write that
   * settles this call failed -- this reports what actually happened
   * rather than telling the caller the data is safely on disk when it is
   * not (see writeNow). Resolves right away, without throwing, when
   * nothing is pending.
   *
   * Exists for tests, and for the quit-time flush in index.ts: waiting on
   * the real write, instead of a guessed delay, is what makes the
   * debounce test's timing deterministic, and what lets quit wait for a
   * genuine "safe to exit" signal instead of a fixed pause. */
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
   * settle. See `runWrite` for what happens once the timer actually fires:
   * that is where overlapping writes are prevented, not here. */
  private scheduleWrite (): void {
    if (this.writeTimer !== null) clearTimeout(this.writeTimer)
    if (this.pendingWrite === null) {
      this.pendingWrite = new Promise((resolve, reject) => {
        this.resolvePendingWrite = resolve
        this.rejectPendingWrite = reject
      })
      // Nothing observes a rejection unless a caller awaits
      // flushPendingWrite() (index.ts's quit flush is the only production
      // caller, and it always does). Without this, a failed write with no
      // such caller listening at the moment it settles would print an
      // unhandled-rejection warning on top of the console.error writeNow
      // already logs.
      this.pendingWrite.catch(() => {})
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      this.runWrite()
    }, WRITE_DEBOUNCE_MS)
  }

  /** Starts a write, unless one is already running -- in which case it
   * only records that the list has changed again (`rerunRequested`) and
   * returns, leaving the in-flight write alone. This is what keeps at most
   * one writeNow() running at a time: two overlapping writes can land in
   * either order, so whichever finishes last wins even when it started
   * from the staler list. A change that arrives mid-write is instead
   * folded into the NEXT write -- which reads `this.list` fresh when it
   * starts -- rather than racing a second write against the first. */
  private runWrite (): void {
    if (this.writeInFlight) {
      this.rerunRequested = true
      return
    }
    this.writeInFlight = true
    void this.writeNow().then(
      () => { this.afterWrite(null) },
      (error: unknown) => { this.afterWrite(error) }
    )
  }

  /** Runs after a write finishes, successfully or not. If the list changed
   * while it was running, that change is not on disk yet even if this
   * write itself succeeded -- run again immediately (no further debounce;
   * the point of debouncing is batching rapid changes before a write
   * starts, not delaying one a change is already waiting on) rather than
   * settling on stale success. Otherwise this was the last write needed
   * for the current burst: settle. */
  private afterWrite (error: unknown): void {
    this.writeInFlight = false
    if (this.rerunRequested) {
      this.rerunRequested = false
      this.runWrite()
      return
    }
    this.settleWrite(error)
  }

  /** The only place `pendingWrite` is resolved or rejected. Called from
   * afterWrite once a write has finished and `writeInFlight` is already
   * clear, but `writeTimer` may still be running: a change can arrive
   * while a write is in flight and reach `scheduleWrite` (queuing a fresh
   * timer for it) before that write finishes and finds `rerunRequested`
   * still false, because the timer had not fired yet to set it. Settling
   * here anyway would resolve the caller before that queued write has
   * happened, so this waits for `writeTimer` too. Clears all three
   * pending-write fields so the next change starts a fresh promise instead
   * of reusing one that already settled. */
  private settleWrite (error: unknown): void {
    if (this.writeTimer !== null || this.writeInFlight) return
    const resolve = this.resolvePendingWrite
    const reject = this.rejectPendingWrite
    this.pendingWrite = null
    this.resolvePendingWrite = null
    this.rejectPendingWrite = null
    if (error !== null) {
      if (reject !== null) reject(error)
    } else if (resolve !== null) {
      resolve()
    }
  }

  private async writeNow (): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(this.filePath, serializeBookmarksFile(this.list), 'utf8')
    } catch (error) {
      // Loud, never silent -- same policy index.ts applies to subsystem
      // failures. Losing a write is recoverable; hiding it is not.
      console.error('[orivon] failed to persist bookmarks:', error)
      // Re-thrown so runWrite's caller (afterWrite) learns the write
      // failed and settleWrite rejects flushPendingWrite instead of
      // reporting a failed write as though it landed.
      throw error
    }
  }
}
