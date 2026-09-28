// What the page knows about the settings, kept in step with main: loaded once,
// then updated by what this page changes and by changes made elsewhere while it
// is open (another Settings tab, a reset).
import type { SettingDescription } from '../../../main/settings/schema.js'
import { internalBridge } from '../shared/bridge.js'
import type { OrivonInternal } from '../shared/bridge.js'
import { ShortcutsState } from './shortcuts-state.js'

export interface AboutInfo {
  readonly version: string
  readonly electron: string
  readonly chromium: string
  readonly node: string
  readonly platform: string
  readonly userAgent: string
}

interface GetReply {
  readonly descriptions: readonly SettingDescription[]
  readonly values: Readonly<Record<string, unknown>>
}

type Outcome = { readonly ok: true } | { readonly ok: false, readonly reason: string }

export class SettingsState {
  readonly descriptions = new Map<string, SettingDescription>()
  private readonly values = new Map<string, unknown>()
  about: AboutInfo | null = null
  readonly shortcuts: ShortcutsState
  private readonly listeners = new Set<() => void>()

  constructor (private readonly bridge: OrivonInternal = internalBridge()) {
    this.shortcuts = new ShortcutsState(bridge, () => { this.notify() })
  }

  async load (): Promise<void> {
    const reply = await this.bridge.request('settings', { type: 'get' }) as GetReply
    for (const description of reply.descriptions) this.descriptions.set(description.key, description)
    for (const [key, value] of Object.entries(reply.values)) this.values.set(key, value)
    this.about = await this.bridge.request('about', {}) as AboutInfo
    await this.shortcuts.load()
    this.bridge.onEvent((topic, payload) => {
      if (this.shortcuts.handle(topic, payload) || topic !== 'settings.changed') return
      const change = payload as { key: string, value: unknown }
      this.values.set(change.key, change.value)
      this.notify()
    })
  }

  value (key: string): unknown {
    return this.values.get(key)
  }

  description (key: string): SettingDescription | undefined {
    return this.descriptions.get(key)
  }

  isChanged (key: string): boolean {
    return this.values.get(key) !== this.descriptions.get(key)?.default
  }

  /** Returns why main refused, or null when it took the value. */
  async set (key: string, value: unknown): Promise<string | null> {
    return await this.apply({ type: 'set', key, value }, key, value)
  }

  async reset (key: string): Promise<void> {
    await this.apply({ type: 'reset', key }, key, this.descriptions.get(key)?.default)
  }

  async resetAll (): Promise<void> {
    await this.bridge.request('settings', { type: 'resetAll' })
    for (const description of this.descriptions.values()) this.values.set(description.key, description.default)
    this.notify()
  }

  onChange (listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private async apply (command: object, key: string, value: unknown): Promise<string | null> {
    const outcome = await this.bridge.request('settings', command) as Outcome | undefined
    if (outcome?.ok !== true) return 'That value is not allowed.'
    this.values.set(key, value)
    this.notify()
    return null
  }

  private notify (): void {
    for (const listener of this.listeners) listener()
  }
}
