// What the page knows about the installed extensions, kept in step with
// main: loaded once, then refreshed whenever the registry changes (here or
// in another window on this page), over `extensions.changed` -- never by
// polling.
import { internalBridge } from '../shared/bridge.js'
import type { OrivonInternal } from '../shared/bridge.js'

export interface ExtensionRow {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly description: string
  readonly enabled: boolean
  readonly iconDataUrl: string | undefined
}

export interface ExtensionDetails {
  readonly id: string
  readonly source: string
  readonly updates: string
  readonly siteAccess: string | undefined
  readonly stripped: readonly string[]
  readonly whereItRuns: string
  readonly reloadable: boolean
  readonly isStoreManaged: boolean
  readonly updateAvailable: boolean
}

interface InstallReply {
  readonly installed: boolean
  readonly reason?: string
}

const REMOVE_ARM_MS = 4_000

export class ExtensionsState {
  rows: readonly ExtensionRow[] = []
  loaded = false
  developerMode = false
  expandedId: string | null = null
  armedRemoveId: string | null = null
  /** Why the last install/load attempt failed, or null: cleared on success
   * and on a cancelled picker, since a person choosing not to pick a file is
   * not an error. */
  message: string | null = null
  readonly details = new Map<string, ExtensionDetails>()
  private readonly listeners = new Set<() => void>()
  private disarmTimer: ReturnType<typeof setTimeout> | undefined

  constructor (private readonly bridge: OrivonInternal = internalBridge()) {}

  async load (): Promise<void> {
    const [list, settings] = await Promise.all([
      this.bridge.request('extensions', { type: 'list' }) as Promise<{ rows: readonly ExtensionRow[] }>,
      this.bridge.request('settings', { type: 'get' }) as Promise<{ values: Readonly<Record<string, unknown>> }>
    ])
    this.rows = list.rows
    this.developerMode = settings.values['extensions.developerMode'] === true
    this.loaded = true
    this.bridge.onEvent((topic, payload) => {
      if (topic === 'extensions.changed') { void this.refresh(); return }
      if (topic !== 'settings.changed') return
      const change = payload as { key: string, value: unknown }
      if (change.key === 'extensions.developerMode') {
        this.developerMode = change.value === true
        this.notify()
      }
    })
    this.notify()
  }

  async toggleExpand (id: string): Promise<void> {
    if (this.expandedId === id) {
      this.expandedId = null
      this.notify()
      return
    }
    this.expandedId = id
    this.notify()
    await this.loadDetails(id)
  }

  async setEnabled (id: string, enabled: boolean): Promise<void> {
    await this.bridge.request('extensions', { type: 'setEnabled', id, enabled })
    await this.refresh()
  }

  armRemove (id: string): void {
    this.armedRemoveId = id
    if (this.disarmTimer !== undefined) clearTimeout(this.disarmTimer)
    this.disarmTimer = setTimeout(() => { this.armedRemoveId = null; this.notify() }, REMOVE_ARM_MS)
    this.notify()
  }

  async remove (id: string): Promise<void> {
    if (this.disarmTimer !== undefined) clearTimeout(this.disarmTimer)
    this.armedRemoveId = null
    if (this.expandedId === id) this.expandedId = null
    await this.bridge.request('extensions', { type: 'remove', id })
    await this.refresh()
  }

  async setDeveloperMode (value: boolean): Promise<void> {
    await this.bridge.request('settings', { type: 'set', key: 'extensions.developerMode', value })
    this.developerMode = value
    this.notify()
  }

  async loadUnpacked (): Promise<void> {
    const outcome = await this.bridge.request('extensions', { type: 'loadUnpacked' }) as InstallReply
    await this.afterInstall(outcome)
  }

  async reload (id: string): Promise<void> {
    const outcome = await this.bridge.request('extensions', { type: 'reload', id }) as InstallReply
    await this.afterInstall(outcome)
  }

  async installFromFile (): Promise<void> {
    const outcome = await this.bridge.request('extensions', { type: 'installFromFile' }) as InstallReply
    await this.afterInstall(outcome)
  }

  async checkForUpdates (): Promise<void> {
    await this.bridge.request('extensions', { type: 'checkForUpdates' })
    await this.refresh()
  }

  async updateNow (id: string): Promise<void> {
    const outcome = await this.bridge.request('extensions', { type: 'updateNow', id }) as InstallReply
    await this.afterInstall(outcome)
  }

  onChange (listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private async afterInstall (outcome: InstallReply): Promise<void> {
    this.message = outcome.installed || outcome.reason === 'cancelled' ? null : (outcome.reason ?? 'That could not be installed.')
    this.notify()
    if (outcome.installed) await this.refresh()
  }

  private async refresh (): Promise<void> {
    const reply = await this.bridge.request('extensions', { type: 'list' }) as { rows: readonly ExtensionRow[] }
    this.rows = reply.rows
    if (this.expandedId !== null && !this.rows.some((row) => row.id === this.expandedId)) this.expandedId = null
    this.notify()
    if (this.expandedId !== null) await this.loadDetails(this.expandedId)
  }

  private async loadDetails (id: string): Promise<void> {
    const reply = await this.bridge.request('extensions', { type: 'details', id }) as { details: ExtensionDetails } | undefined
    if (reply !== undefined) {
      this.details.set(id, reply.details)
      this.notify()
    }
  }

  private notify (): void {
    for (const listener of this.listeners) listener()
  }
}
