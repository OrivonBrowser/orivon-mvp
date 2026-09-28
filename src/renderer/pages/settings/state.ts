// What the page knows about the settings, kept in step with main: loaded once,
// then updated by what this page changes and by changes made elsewhere while it
// is open (another Settings tab, a reset).
import type { SettingDescription } from '../../../main/settings/schema.js'
import { internalBridge } from '../shared/bridge.js'
import type { OrivonInternal } from '../shared/bridge.js'
import { PrivacyState } from './privacy-state.js'
import { ShortcutsState } from './shortcuts-state.js'

export interface AboutInfo {
  readonly version: string
  readonly electron: string
  readonly chromium: string
  readonly node: string
  readonly platform: string
  readonly userAgent: string
  readonly developerMode: boolean
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
  readonly privacy: PrivacyState
  /** This profile and the others, and whether this window is private. */
  profiles: { readonly profiles: ReadonlyArray<{ readonly id: string, readonly name: string, readonly current: boolean }>, readonly isPrivate: boolean } | null = null
  private readonly listeners = new Set<() => void>()

  constructor (private readonly bridge: OrivonInternal = internalBridge()) {
    this.shortcuts = new ShortcutsState(bridge, () => { this.notify() })
    this.privacy = new PrivacyState(bridge)
  }

  async load (): Promise<void> {
    const reply = await this.bridge.request('settings', { type: 'get' }) as GetReply
    for (const description of reply.descriptions) this.descriptions.set(description.key, description)
    for (const [key, value] of Object.entries(reply.values)) this.values.set(key, value)
    this.about = await this.bridge.request('about', {}) as AboutInfo
    await this.shortcuts.load()
    await this.privacy.load()
    this.profiles = await this.bridge.request('profiles', { type: 'list' }) as SettingsState['profiles']
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

  /** Starts a private window: a browser of its own. */
  async openPrivate (): Promise<void> {
    await this.bridge.request('profiles', { type: 'newPrivate' })
  }

  /** Takes the person to another of the shell's own pages, in this window. */
  async openPage (page: string, path?: string): Promise<void> {
    await this.bridge.request('pages', { type: 'open', page, ...(path === undefined ? {} : { path }) })
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
