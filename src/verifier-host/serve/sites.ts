// Mounted `.eth` sites by host and partition, kept a short while so one
// page's many requests read one root without resolving the name for each.
// A partition is the top-level page origin a request came from: a name one
// site's pages opened is cold for every other site, so timing a request
// tells a page nothing about where the person has been (A256).

import { ResolutionError } from '../../resolution/records.js'
import type { MountedSite } from '../../resolution/providers.js'
import type { ResolutionRegistry } from '../../resolution/registry.js'
import { Slots } from '../../resolution/slots.js'

/** How long a proven name stays fresh -- served with no re-check at all. */
export const SITE_TTL_MS = 2 * 60_000
/** Past `SITE_TTL_MS` but within this age, a name that once proved keeps
 * being served (a background re-prove runs to refresh it) rather than
 * making every request past the TTL wait on one, or fail outright because
 * a single re-prove attempt hit a transient RPC blip. Real browser caching
 * already works this way (`stale-while-revalidate`); this gives `.eth` the
 * same tolerance instead of a hard cliff at `SITE_TTL_MS`. */
export const STALE_SERVE_MS = 10 * 60_000
/** A failed re-prove is not retried instantly -- this paces the retries a
 * burst of requests past the TTL would otherwise each trigger. */
export const FAILURE_TTL_MS = 5_000
/** A light client fed a lie it keeps rejecting retries for over a minute; a tab gets its answer sooner. */
export const MOUNT_TIMEOUT_MS = 25_000
/** Names kept at once, the least recently used dropped first: any page can make the host look up any number of names. */
export const MAX_SITES = 64
/** Names being proven at once. The rest wait, inside their own deadline. */
export const MAX_CONCURRENT_MOUNTS = 4

export interface SiteRecord {
  readonly site: MountedSite
  readonly resolver: string
  readonly mountedAt: number
}

interface Entry {
  /** The mount this entry is currently waiting on: the very first one for
   * this key, once there is no `good` yet. Once `good` exists, a fresh
   * request within `SITE_TTL_MS` still reads this directly (it is simply
   * the already-resolved record), so nothing above needs to branch on
   * whether `good` exists for the FRESH case -- only the stale one below
   * does. */
  settled: Promise<SiteRecord>
  /** Past this, `settled` is no longer served with no check at all. */
  expires: number
  /** True once `settled` has rejected. `expires` then marks when a fresh
   * attempt may start, not "still good". */
  failed: boolean
  /** The last successful mount for this key. Never cleared by a failed
   * re-prove: the whole point of keeping it is to answer with something
   * proven while a retry is pending. Explicit `| undefined`, not an
   * optional property: this codebase's `exactOptionalPropertyTypes`
   * distinguishes "absent" from "present and undefined", and this entry
   * always assigns one or the other rather than omitting the key. */
  good: SiteRecord | undefined
  /** A background re-prove already running -- kept separate from `expires`
   * so a stale request is served the same fast, non-blocking way whether
   * or not one happens to already be in flight; `expires` alone conflating
   * "still fresh" with "a revalidation was just paced" would make the
   * SECOND concurrent stale caller wait on the revalidation the FIRST one
   * only started as a side effect, which is not what either caller asked
   * for. */
  revalidating: Promise<void> | undefined
  /** Paces a FAILED revalidation's retry; checked only once nothing is
   * currently revalidating. */
  retryAt: number | undefined
}

export class Sites {
  /** In order of last use, oldest first. */
  private readonly entries = new Map<string, Entry>()
  private readonly mounting = new Slots(MAX_CONCURRENT_MOUNTS)

  constructor (
    private readonly registry: ResolutionRegistry,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = MOUNT_TIMEOUT_MS
  ) {}

  /** Throws a ResolutionError. With no partition the mount is served once and never kept, nor are its blocks. */
  async get (host: string, partition: string | undefined): Promise<SiteRecord> {
    if (partition === undefined) return await this.mount(host, undefined)
    const key = `${partition} ${host}`
    const current = this.entries.get(key)
    const now = this.now()

    if (current !== undefined && current.expires > now) {
      this.use(key, current)
      return await current.settled
    }

    // Past the fresh window (or gone/never mounted). A name that has
    // proved before and is not yet too old to serve keeps answering with
    // its last good record while a re-prove runs in the background --
    // never awaited by THIS call.
    if (current?.good !== undefined && now - current.good.mountedAt <= STALE_SERVE_MS) {
      this.use(key, current)
      this.revalidate(key, current, host, partition)
      return current.good
    }

    const entry: Entry = { settled: this.mount(host, partition), expires: now + SITE_TTL_MS, failed: false, good: current?.good, revalidating: undefined, retryAt: undefined }
    this.use(key, entry)
    entry.settled.then(
      (record) => { entry.good = record },
      () => {
        entry.failed = true
        entry.expires = this.now() + FAILURE_TTL_MS
      }
    ).catch(() => {}) // the .then() above never itself throws; belt only
    return await entry.settled
  }

  /** Starts a background re-prove for `key`, unless one is already running
   * or a previous failure's retry delay has not yet passed. On success,
   * `good` and `settled` both move to the fresh record and the TTL resets;
   * on failure, `good` is untouched and a short retry delay is set so a
   * burst of stale requests paces to one re-prove, not one each. */
  private revalidate (key: string, entry: Entry, host: string, partition: string): void {
    if (entry.revalidating !== undefined) return
    if (entry.retryAt !== undefined && entry.retryAt > this.now()) return
    const attempt = this.mount(host, partition)
    entry.revalidating = attempt.then(
      (record) => {
        entry.good = record
        entry.settled = Promise.resolve(record)
        entry.expires = this.now() + SITE_TTL_MS
        entry.retryAt = undefined
      },
      () => {
        entry.retryAt = this.now() + FAILURE_TTL_MS
      }
    ).finally(() => { entry.revalidating = undefined })
  }

  /** The site currently mounted for `host` in `partition`, without
   * resolving anything. Serves a stale `good` the same way `get` does. */
  async current (host: string, partition: string): Promise<SiteRecord | undefined> {
    const entry = this.entries.get(`${partition} ${host}`)
    if (entry === undefined) return undefined
    if (entry.good !== undefined && this.now() - entry.good.mountedAt <= STALE_SERVE_MS) return entry.good
    try {
      return await entry.settled
    } catch {
      return entry.good
    }
  }

  /** Moves `key` to the newest end, and drops expired failures and the oldest names past the cap. */
  private use (key: string, entry: Entry): void {
    this.entries.delete(key)
    this.entries.set(key, entry)
    const now = this.now()
    for (const [name, kept] of this.entries) {
      if (kept.failed && kept.good === undefined && kept.expires <= now) this.entries.delete(name)
    }
    for (const name of this.entries.keys()) {
      if (this.entries.size <= MAX_SITES) break
      this.entries.delete(name)
    }
  }

  /** Forget every mount, so the next request proves its name again. */
  clear (): void {
    this.entries.clear()
  }

  private async mount (host: string, partition: string | undefined): Promise<SiteRecord> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new ResolutionError('unavailable', `${host} could not be verified within ${String(this.timeoutMs / 1000)} s`))
      }, this.timeoutMs)
    })
    try {
      return await Promise.race([deadline, this.mounting.run(async () => {
        controller.signal.throwIfAborted()
        const resolved = await this.registry.resolve(host, controller.signal)
        const site = await this.registry.mount(resolved.name, resolved.records, controller.signal, partition)
        return { site, resolver: resolved.resolver, mountedAt: this.now() }
      })])
    } finally {
      clearTimeout(timer)
    }
  }
}
