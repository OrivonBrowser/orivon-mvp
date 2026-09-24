// Mounted `.eth` sites by host, kept a short while so one page's many
// requests read one root without resolving the name for each.

import type { MountedSite } from '../resolution/providers.js'
import type { ResolutionRegistry } from '../resolution/registry.js'

/** How long a proven name stays in use before it is proven again. */
export const SITE_TTL_MS = 2 * 60_000
/** A failure is remembered briefly, so a page's burst of requests fails once rather than once each. */
export const FAILURE_TTL_MS = 5_000

export interface SiteRecord {
  readonly site: MountedSite
  readonly resolver: string
  readonly mountedAt: number
}

interface Entry {
  readonly settled: Promise<SiteRecord>
  expires: number
}

export class Sites {
  private readonly entries = new Map<string, Entry>()

  constructor (private readonly registry: ResolutionRegistry, private readonly now: () => number = Date.now) {}

  /** Throws a ResolutionError. */
  async get (host: string): Promise<SiteRecord> {
    const current = this.entries.get(host)
    if (current !== undefined && current.expires > this.now()) return await current.settled
    const entry: Entry = { settled: this.mount(host), expires: this.now() + SITE_TTL_MS }
    this.entries.set(host, entry)
    entry.settled.catch(() => {
      if (this.entries.get(host) === entry) entry.expires = this.now() + FAILURE_TTL_MS
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

  /** Forget every mount, so the next request proves its name again. */
  clear (): void {
    this.entries.clear()
  }

  private async mount (host: string): Promise<SiteRecord> {
    const resolved = await this.registry.resolve(host)
    const site = await this.registry.mount(resolved.name, resolved.records)
    return { site, resolver: resolved.resolver, mountedAt: this.now() }
  }
}
