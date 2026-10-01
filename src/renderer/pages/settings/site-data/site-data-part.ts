// What the "Sites that store data" rows know: the sites main listed, how much they take, what is typed in the
// search, which site is open and which button waits for its second click. It asks main and never touches the
// page; ./site-data-view.ts draws it.
import type { HostCookies, SiteRow } from '../../../../main/privacy/site-data-domain.js'
import type { OrivonInternal } from '../../shared/bridge.js'
import { armEnded } from '../../shared/armed.js'
import type { SettingsPart } from '../settings-parts.js'
import { defaultSort, filterSites, sortSites, visibleSites } from './site-data-model.js'
import type { SiteSort } from './site-data-model.js'

/** A second click after this long starts over. */
export const ARM_MS = 4000

type ArmTarget = { readonly kind: 'site', readonly domain: string } | { readonly kind: 'all' }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

export class SiteDataPart implements SettingsPart {
  /** Null until main has answered. */
  sites: readonly SiteRow[] | null = null
  /** Bytes the sites and the cache take; null while it is being worked out. */
  total: number | null = null
  query = ''
  sort: SiteSort = 'name'
  showAll = false
  /** The domains whose hosts and cookies are showing, and what main said about each. */
  readonly open = new Set<string>()
  readonly hosts = new Map<string, readonly HostCookies[]>()
  armed: ArmTarget | null = null
  /** The last delete could not be completed. */
  failed = false
  private sortChosen = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly listeners = new Set<() => void>()

  constructor (private readonly bridge: OrivonInternal, private readonly notify: () => void) {}

  /** Starts reading and does not wait: the page opens at once on grey rows, and the list fills in when main has measured it. */
  load (): Promise<void> {
    void this.fetch().catch(() => { this.sites = this.sites ?? []; this.changed() })
    return Promise.resolve()
  }

  private async fetch (): Promise<void> {
    const reply = await this.bridge.request('siteData', { type: 'list' })
    if (!isRecord(reply) || !Array.isArray(reply['sites'])) return
    this.sites = reply['sites'] as SiteRow[]
    if (!this.sortChosen) this.sort = defaultSort(this.sites)
    for (const domain of [...this.open]) if (!this.sites.some((site) => site.domain === domain)) this.open.delete(domain)
    this.local()
    const total = await this.bridge.request('siteData', { type: 'total' })
    this.total = isRecord(total) && typeof total['bytes'] === 'number' ? total['bytes'] : null
    this.changed()
  }

  /** Reads everything again, as after a clear made elsewhere on the page. */
  async reload (): Promise<void> {
    this.total = null
    this.hosts.clear()
    await this.fetch()
    for (const domain of this.open) await this.loadHosts(domain)
    this.changed()
  }

  /** The view redraws itself on this; the page redraws on `notify`, which the total row needs. */
  subscribe (listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  rows (): { readonly shown: readonly SiteRow[], readonly hidden: number, readonly matching: number } {
    const matching = sortSites(filterSites(this.sites ?? [], this.query), this.sort)
    return { ...visibleSites(matching, this.showAll), matching: matching.length }
  }

  setQuery (query: string): void {
    this.query = query
    this.showAll = false
    this.local()
  }

  setSort (sort: SiteSort): void {
    this.sort = sort
    this.sortChosen = true
    this.local()
  }

  showEverything (): void {
    this.showAll = true
    this.local()
  }

  async toggle (domain: string): Promise<void> {
    if (this.open.delete(domain)) { this.local(); return }
    this.open.add(domain)
    this.local()
    if (!this.hosts.has(domain)) await this.loadHosts(domain)
    this.local()
  }

  private async loadHosts (domain: string): Promise<void> {
    const reply = await this.bridge.request('siteData', { type: 'cookies', domain })
    if (isRecord(reply) && Array.isArray(reply['hosts'])) this.hosts.set(domain, reply['hosts'] as HostCookies[])
  }

  /** One cookie, deleted at once. */
  async removeCookie (domain: string, key: string): Promise<void> {
    const reply = await this.bridge.request('siteData', { type: 'removeCookie', key })
    this.failed = !(isRecord(reply) && reply['ok'] === true)
    await this.refreshAfterDelete(domain)
  }

  /** First click arms, the second deletes the site's data. */
  async pressDeleteSite (domain: string): Promise<void> {
    if (!this.isArmed({ kind: 'site', domain })) { this.arm({ kind: 'site', domain }); return }
    this.disarm()
    const reply = await this.bridge.request('siteData', { type: 'removeSite', domain })
    this.failed = !(isRecord(reply) && reply['ok'] === true)
    this.open.delete(domain)
    this.hosts.delete(domain)
    await this.refreshAfterDelete(null)
  }

  /** First click arms, the second deletes every site's cookies and storage. */
  async pressDeleteAll (): Promise<void> {
    if (!this.isArmed({ kind: 'all' })) { this.arm({ kind: 'all' }); return }
    this.disarm()
    const reply = await this.bridge.request('privacy', { type: 'clear', request: { history: 'none', siteData: true, cache: false, zoomLevels: false, appData: false } })
    this.failed = !(isRecord(reply) && reply['ok'] === true)
    this.open.clear()
    this.hosts.clear()
    await this.refreshAfterDelete(null)
  }

  isArmed (target: ArmTarget): boolean {
    const now = this.armed
    if (now === null || now.kind !== target.kind) return false
    return now.kind === 'all' || (target.kind === 'site' && now.domain === target.domain)
  }

  private arm (target: ArmTarget): void {
    this.armed = target
    this.failed = false
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.disarm(); this.local(); armEnded() }, ARM_MS)
    this.local()
  }

  private disarm (): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.armed = null
  }

  private async refreshAfterDelete (domain: string | null): Promise<void> {
    this.total = null
    await this.fetch()
    if (domain !== null && this.open.has(domain)) await this.loadHosts(domain)
    this.changed()
    armEnded()
  }

  private local (): void {
    for (const listener of [...this.listeners]) listener()
  }

  private changed (): void {
    this.local()
    this.notify()
  }
}
