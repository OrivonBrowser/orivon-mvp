// What the page knows that outlives a view: whether this is a private
// runtime and whether Developer mode is on. Each view fetches its own data
// through `PageContext.request`; nothing here touches the DOM.
import { internalBridge } from '../shared/bridge.js'
import type { OrivonInternal } from '../shared/bridge.js'

export interface ExtensionRow {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly description: string
  readonly enabled: boolean
  readonly iconDataUrl: string | undefined
  /** What each feature added for its own badge, keyed by the feature. */
  readonly parts: Readonly<Record<string, unknown>>
}

export interface DetailsPayload {
  readonly id: string
  readonly row: ExtensionRow
  readonly source: string
  readonly updates: string
  readonly siteAccess: string | undefined
  readonly stripped: readonly string[]
  readonly whereItRuns: string
  readonly reloadable: boolean
  readonly isStoreManaged: boolean
  readonly updateAvailable: boolean
  /** What each feature added for its own section, keyed by the feature. */
  readonly parts: Readonly<Record<string, unknown>>
}

export interface InstallReply {
  readonly installed: boolean
  readonly reason?: string
}

export class PageState {
  developerMode = false
  isPrivate = false
  private readonly listeners = new Set<() => void>()

  constructor (readonly bridge: OrivonInternal = internalBridge()) {}

  async load (): Promise<void> {
    const [context, settings] = await Promise.all([
      this.bridge.request('extensions', { type: 'context' }) as Promise<{ isPrivate: boolean } | undefined>,
      this.bridge.request('settings', { type: 'get' }) as Promise<{ values: Readonly<Record<string, unknown>> }>
    ])
    this.isPrivate = context?.isPrivate === true
    this.developerMode = settings.values['extensions.developerMode'] === true
    this.bridge.onEvent((topic, payload) => {
      if (topic === 'extensions.changed') { this.notify(); return }
      if (topic !== 'settings.changed') return
      const change = payload as { key: string, value: unknown }
      if (change.key === 'extensions.developerMode') {
        this.developerMode = change.value === true
        this.notify()
      }
    })
  }

  async request<T> (type: string, body: object = {}): Promise<T> {
    return await this.bridge.request('extensions', { ...body, type }) as T
  }

  /** Called when what the page shows may have changed (the registry, Developer mode). Returns the removal. */
  onChange (listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify (): void {
    for (const listener of this.listeners) listener()
  }
}
