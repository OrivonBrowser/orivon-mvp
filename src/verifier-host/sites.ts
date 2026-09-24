// Mounted `.eth` sites by host, kept a short while so one page's many
// requests read one root without resolving the name for each.

import { ResolutionError } from '../resolution/records.js'
import type { MountedSite } from '../resolution/providers.js'
import type { ResolutionRegistry } from '../resolution/registry.js'
import { Slots } from '../resolution/slots.js'

/** How long a proven name stays in use before it is proven again. */
export const SITE_TTL_MS = 2 * 60_000
/** A failure is remembered briefly, so a page's burst of requests fails once rather than once each. */
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
  readonly settled: Promise<SiteRecord>
  expires: number
  failed: boolean
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

  /** Throws a ResolutionError. */
  async get (host: string): Promise<SiteRecord> {
    const current = this.entries.get(host)
    if (current !== undefined && current.expires > this.now()) {
      this.use(host, current)
      return await current.settled
    }
    const entry: Entry = { settled: this.mount(host), expires: this.now() + SITE_TTL_MS, failed: false }
    this.use(host, entry)
    entry.settled.catch(() => {
      entry.failed = true
      entry.expires = this.now() + FAILURE_TTL_MS
    })
    return await entry.settled
  }

  /** The site currently mounted for `host`, without resolving anything. */
  async current (host: string): Promise<SiteRecord | undefined> {
    const entry = this.entries.get(host)
    if (entry === undefined) return undefined
    try {
      return await entry.settled
    } catch {
      return undefined
    }
  }

  /** Moves `host` to the newest end, and drops expired failures and the oldest names past the cap. */
  private use (host: string, entry: Entry): void {
    this.entries.delete(host)
    this.entries.set(host, entry)
    const now = this.now()
    for (const [name, kept] of this.entries) {
      if (kept.failed && kept.expires <= now) this.entries.delete(name)
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

  private async mount (host: string): Promise<SiteRecord> {
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
        const site = await this.registry.mount(resolved.name, resolved.records, controller.signal)
        return { site, resolver: resolved.resolver, mountedAt: this.now() }
      })])
    } finally {
      clearTimeout(timer)
    }
  }
}
