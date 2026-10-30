// Mounted sites by host and partition, kept a short while so one
// page's many requests read one root without resolving the name for each.
// A partition is the top-level page origin a request came from: a name one
// site's pages opened is cold for every other site, so timing a request
// tells a page nothing about where the person has been (A256).

import { GatewaysOffered, ResolutionError } from '../../resolution/records.js'
import type { MountedSite } from '../../resolution/providers.js'
import type { ProtocolRegistry } from '../../registry.js'
import { Slots } from '../../resolution/slots.js'
import type { FetchRoute, TunnelRoute } from '../protocol.js'

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
export const MOUNT_TIMEOUT_MS = 45_000
/** Names kept at once, the least recently used dropped first: any page can make the host look up any number of names. */
export const MAX_SITES = 64
/** After the deadline aborts a mount, how long the mount has to say why it stopped before the deadline answers for it. */
const ABORT_GRACE_MS = 200
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
  revalidating: Promise<SiteRecord> | undefined
  /** Paces a FAILED revalidation's retry; checked only once nothing is
   * currently revalidating. */
  retryAt: number | undefined
}

export class Sites {
  /** In order of last use, oldest first. */
  private readonly entries = new Map<string, Entry>()
  private readonly mounting = new Slots(MAX_CONCURRENT_MOUNTS)
  /** `latest` asks one name at a time: a round of update checks holds one of the mount slots however many apps are open, so a page load never waits behind it. */
  private readonly asking = new Slots(1)

  constructor (
    private readonly registry: ProtocolRegistry,
    private readonly now: () => number = Date.now,
    /** The wait for one mount, read when the mount starts: a route's patience follows what it has measured. */
    private readonly timeoutMs: number | (() => number) = MOUNT_TIMEOUT_MS,
    /** Told which gatherer is about to load a host's records, before any of its content is fetched, whatever partition the mount is for. Not told of a mount the deadline has already failed. */
    private readonly onGatherer: (host: string, gatherer: string) => void = () => {},
    /**
     * Whether a mounted site must be mounted again for a page load the person starts: one that a yes loaded for one load (the next load
     * asks again), and one the node served while the person has just said yes to gateways for this site (the load they asked for).
     */
    private readonly remount: (site: MountedSite, partition: string) => boolean = () => false
  ) {}

  /**
   * Throws a ResolutionError. With no partition the mount is served once and never kept, nor are its blocks.
   * `retry` is a person's own request for the page (a reload, a click on Try again): it does not replay a
   * remembered failure, and starts the mount again. A mount still running is joined, never restarted.
   * `fresh` is a page load the person started (a tab's document navigation, not a frame's or a file's): it does not reuse a site
   * that `remount` names, nor one that says it holds a newer version (`MountedSite.hasNewer`).
   */
  async get (host: string, partition: string | undefined, retry = false, fresh = false): Promise<SiteRecord> {
    if (partition === undefined) return await this.mount(host, undefined)
    const key = `${partition} ${host}`
    let current = this.entries.get(key)
    if (fresh && current?.good !== undefined && (current.good.site.hasNewer?.() === true || this.remount(current.good.site, partition))) {
      this.entries.delete(key)
      current = undefined
    }
    const now = this.now()

    if (current !== undefined && current.expires > now && !(retry && current.failed)) {
      this.use(key, current)
      return await current.settled
    }

    // Past the fresh window (or gone/never mounted). A name that has
    // proved before and is not yet too old to serve keeps answering with
    // its last good record while a re-prove runs in the background --
    // never awaited by THIS call.
    if (current?.good !== undefined && now - current.good.mountedAt <= STALE_SERVE_MS) {
      this.use(key, current)
      this.revalidate(current, host, partition)
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

  /** Starts a background re-prove, unless one is already running or a
   * previous failure's retry delay has not yet passed. */
  private revalidate (entry: Entry, host: string, partition: string): void {
    if (entry.revalidating !== undefined) return
    if (entry.retryAt !== undefined && entry.retryAt > this.now()) return
    // The caller has its answer already; a failure reads as `retryAt`.
    this.reprove(entry, host, partition).catch(() => {})
  }

  /** The re-prove running, or a new one. On success, `good` and `settled`
   * both move to the fresh record and the TTL resets; on failure, `good` is
   * untouched and a short retry delay is set so a burst of stale requests
   * paces to one re-prove, not one each. */
  private async reprove (entry: Entry, host: string, partition: string): Promise<SiteRecord> {
    entry.revalidating ??= this.mount(host, partition).then(
      (record) => {
        entry.good = record
        entry.settled = Promise.resolve(record)
        entry.expires = this.now() + SITE_TTL_MS
        entry.retryAt = undefined
        return record
      },
      (error: unknown) => {
        entry.retryAt = this.now() + FAILURE_TTL_MS
        throw error
      }
    ).finally(() => { entry.revalidating = undefined })
    return await entry.revalidating
  }

  /**
   * The name as it reads now, for a caller asking whether it moved: a kept record cannot answer that, however fresh it is. What this proves
   * is kept, so the requests that follow read the same root. Throws a ResolutionError and leaves what was kept alone; a mount already running
   * is joined, and a name that has just failed is not asked again until its retry delay has passed.
   */
  async latest (host: string, partition: string): Promise<SiteRecord> {
    return await this.asking.run(async () => {
      const key = `${partition} ${host}`
      const current = this.entries.get(key)
      if (current?.good === undefined || this.now() - current.good.mountedAt > STALE_SERVE_MS) return await this.get(host, partition)
      if (current.revalidating === undefined && current.retryAt !== undefined && current.retryAt > this.now()) {
        throw new ResolutionError('unavailable', `${host} could not be verified a moment ago`)
      }
      this.use(key, current)
      return await this.reprove(current, host, partition)
    })
  }

  /** The site currently mounted for `host` in `partition`, without
   * resolving anything. Serves a stale `good` the same way `get` does, and
   * nothing `get` would refuse to serve. */
  async current (host: string, partition: string): Promise<SiteRecord | undefined> {
    const entry = this.entries.get(`${partition} ${host}`)
    if (entry === undefined) return undefined
    const servable = (record: SiteRecord | undefined): SiteRecord | undefined =>
      record !== undefined && this.now() - record.mountedAt <= STALE_SERVE_MS ? record : undefined
    if (servable(entry.good) !== undefined) return entry.good
    try {
      return servable(await entry.settled)
    } catch {
      return undefined
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
    const timeoutMs = typeof this.timeoutMs === 'function' ? this.timeoutMs() : this.timeoutMs
    let timer: ReturnType<typeof setTimeout> | undefined
    const work = this.mounting.run(async () => {
      controller.signal.throwIfAborted()
      const resolved = await this.registry.resolve(host, controller.signal)
      const site = await this.registry.mount(resolved.name, resolved.records, controller.signal, partition, (gatherer) => {
        if (controller.signal.aborted) return
        try {
          this.onGatherer(host, gatherer)
        } catch (error) {
          console.error('[verifier] reporting a gatherer failed:', error)
        }
      })
      return { site, resolver: resolved.resolver, mountedAt: this.now() }
    })
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        // A gatherer that gives the person a way on when its time runs out (an offer of gateways) says so in the instant the abort reaches it.
        work.then(() => {}, (error: unknown) => { if (error instanceof GatewaysOffered) reject(error) })
        setTimeout(() => { reject(new ResolutionError('unavailable', `${host} could not be verified within ${String(timeoutMs / 1000)} s`)) }, ABORT_GRACE_MS).unref()
      }, timeoutMs)
    })
    try {
      return await Promise.race([deadline, work])
    } finally {
      clearTimeout(timer)
    }
  }
}

/** What the server asks to mount a site: by the route its fetches take. */
export interface SiteSource {
  get: (host: string, partition: string | undefined, route?: FetchRoute, retry?: boolean, fresh?: boolean) => Promise<SiteRecord>
}

/**
 * One `Sites` for each route, so a name a website in a tunnel's profile mounted is proved and read through that tunnel and is
 * never the record a direct website is served from, nor one the other tunnel's websites are served from. A tunnel's `Sites` is
 * made at the first request that names it.
 */
export class RoutedSites implements SiteSource {
  private readonly tunnels = new Map<TunnelRoute, Sites>()

  constructor (private readonly direct: Sites, private readonly tunnel: (route: TunnelRoute) => Sites) {}

  private for (route: FetchRoute | undefined): Sites {
    if (route === undefined || route === 'direct') return this.direct
    let sites = this.tunnels.get(route)
    if (sites === undefined) {
      sites = this.tunnel(route)
      this.tunnels.set(route, sites)
    }
    return sites
  }

  async get (host: string, partition: string | undefined, route?: FetchRoute, retry = false, fresh = false): Promise<SiteRecord> {
    return await this.for(route).get(host, partition, retry, fresh)
  }

  async latest (host: string, partition: string, route?: FetchRoute): Promise<SiteRecord> {
    return await this.for(route).latest(host, partition)
  }

  async current (host: string, partition: string, route?: FetchRoute): Promise<SiteRecord | undefined> {
    return await this.for(route).current(host, partition)
  }
}
