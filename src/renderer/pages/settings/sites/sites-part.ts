// What the Site settings section knows: the defaults and the sites main listed, which sites are open to their own
// rows, what the person typed to search, and which button waits for its second click. It asks main and never touches
// the page; ./sites-view.ts draws it.
import type { OrivonInternal } from '../../shared/bridge.js'
import { armEnded } from '../../shared/armed.js'
import { coalesce } from '../../shared/coalesce.js'
import type { SettingsPart } from '../settings-parts.js'
import { filterSites, visibleSites } from './sites-model.js'
import type { DefaultRow, SiteKindRow, SiteSummary } from './sites-model.js'

/** A second click after this long starts over. */
export const ARM_MS = 4000

interface ListReply {
  readonly isPrivate: boolean
  readonly defaults: readonly DefaultRow[]
  readonly sites: readonly SiteSummary[]
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

function isListReply (value: unknown): value is ListReply {
  return isRecord(value) && typeof value['isPrivate'] === 'boolean' && Array.isArray(value['defaults']) && Array.isArray(value['sites'])
}

function rowsOf (reply: unknown): readonly SiteKindRow[] | null {
  return isRecord(reply) && Array.isArray(reply['rows']) ? reply['rows'] as readonly SiteKindRow[] : null
}

export class SitesPart implements SettingsPart {
  /** False until main has answered. */
  loaded = false
  isPrivate = false
  defaults: readonly DefaultRow[] = []
  sites: readonly SiteSummary[] = []
  query = ''
  showAll = false
  /** The sites open to their own rows, and those rows as main last gave them. */
  readonly open = new Set<string>()
  readonly rows = new Map<string, readonly SiteKindRow[]>()
  armedReset: string | null = null
  armedResetAll = false
  private readonly listeners = new Set<() => void>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly reload: () => void

  constructor (private readonly bridge: OrivonInternal, private readonly notify: () => void) {
    this.reload = coalesce(() => { void this.refresh() })
  }

  async load (): Promise<void> {
    const reply = await this.bridge.request('sites', { type: 'list' })
    if (!isListReply(reply)) return
    this.isPrivate = reply.isPrivate
    this.defaults = reply.defaults
    this.sites = reply.sites
    this.loaded = true
    // A site that lost its last answer has nothing left to open.
    for (const origin of [...this.open]) if (!reply.sites.some((site) => site.origin === origin)) this.close(origin)
    await Promise.all([...this.open].map(async (origin) => { await this.loadRows(origin) }))
  }

  handle (topic: string, payload?: unknown): boolean {
    // A change to a default moves every "(default)" label, but is the settings' own event: noted here, left for the page.
    if (topic === 'settings.changed' && isRecord(payload) && typeof payload['key'] === 'string' && payload['key'].startsWith('sites.')) {
      this.reload()
      return false
    }
    if (topic !== 'sites.changed') return false
    this.reload()
    return true
  }

  /** The view redraws itself on this; the page redraws on `notify`. */
  subscribe (listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  page (): { readonly shown: readonly SiteSummary[], readonly hidden: number, readonly matching: number } {
    const matching = filterSites(this.sites, this.query)
    return { ...visibleSites(matching, this.showAll), matching: matching.length }
  }

  setQuery (query: string): void {
    this.query = query
    this.showAll = false
    this.local()
  }

  showEverything (): void {
    this.showAll = true
    this.local()
  }

  /** Opens or closes a site's own rows. */
  async toggle (origin: string): Promise<void> {
    if (this.open.has(origin)) { this.close(origin); this.local(); return }
    this.open.add(origin)
    await this.loadRows(origin)
    this.local()
  }

  /** Sets one answer in place; main's reply is the truth the rows then show. */
  async choose (origin: string, kind: string, value: string): Promise<void> {
    const reply = await this.bridge.request('sites', { type: 'set', origin, kind, value })
    const rows = rowsOf(reply)
    if (rows !== null) this.rows.set(origin, rows)
    this.local()
  }

  /** First click arms, the second forgets every answer of the site. */
  async pressReset (origin: string): Promise<void> {
    if (this.armedReset !== origin) {
      this.armedReset = origin
      this.after('reset', () => { this.armedReset = null; this.local(); armEnded() })
      this.local()
      return
    }
    this.clearTimer('reset')
    this.armedReset = null
    await this.bridge.request('sites', { type: 'resetSite', origin })
    await this.refresh()
    armEnded()
  }

  /** First click arms, the second forgets every site's answers. */
  async pressResetAll (): Promise<void> {
    if (!this.armedResetAll) {
      this.armedResetAll = true
      this.after('resetAll', () => { this.armedResetAll = false; this.local(); armEnded() })
      this.local()
      return
    }
    this.clearTimer('resetAll')
    this.armedResetAll = false
    await this.bridge.request('sites', { type: 'resetAll' })
    await this.refresh()
    armEnded()
  }

  private async refresh (): Promise<void> {
    await this.load()
    this.changed()
  }

  private async loadRows (origin: string): Promise<void> {
    const rows = rowsOf(await this.bridge.request('sites', { type: 'rows', origin }))
    if (rows === null) this.close(origin)
    else this.rows.set(origin, rows)
  }

  private close (origin: string): void {
    this.open.delete(origin)
    this.rows.delete(origin)
  }

  private after (name: string, run: () => void): void {
    this.clearTimer(name)
    this.timers.set(name, setTimeout(() => { this.timers.delete(name); run() }, ARM_MS))
  }

  private clearTimer (name: string): void {
    const timer = this.timers.get(name)
    if (timer !== undefined) clearTimeout(timer)
    this.timers.delete(name)
  }

  /** A change only the list shows. */
  private local (): void {
    for (const listener of [...this.listeners]) listener()
  }

  /** A change the rest of the section shows too (the defaults rows' labels). */
  private changed (): void {
    this.local()
    this.notify()
  }
}
