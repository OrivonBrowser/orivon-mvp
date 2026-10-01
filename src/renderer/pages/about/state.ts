// What the About page knows: the version table, loaded once, and the graphics
// report, loaded the first time its tab is opened and again on "Try again".
import { internalBridge } from '../shared/bridge.js'
import type { OrivonInternal } from '../shared/bridge.js'

export interface AboutRow {
  readonly label: string
  readonly value: string
  readonly mono: boolean
}

export interface FeatureRow {
  readonly key: string
  readonly label: string
  readonly text: string
  readonly tone: 'ok' | 'warn' | 'danger' | 'neutral'
}

export interface DeviceRow {
  readonly vendor: string
  readonly device: string
  readonly driver: string
  readonly active: boolean
}

export interface GpuReport {
  readonly features: readonly FeatureRow[]
  readonly devices: readonly DeviceRow[]
  readonly devicesKnown: boolean
  readonly raw: string
}

export type Loadable<T> = { readonly state: 'loading' } | { readonly state: 'error' } | { readonly state: 'ready', readonly value: T }

export class AboutState {
  version: Loadable<readonly AboutRow[]> = { state: 'loading' }
  gpu: Loadable<GpuReport> | null = null
  private readonly listeners = new Set<() => void>()

  constructor (private readonly bridge: OrivonInternal = internalBridge()) {}

  onChange (listener: () => void): void {
    this.listeners.add(listener)
  }

  private changed (): void {
    for (const listener of this.listeners) listener()
  }

  async loadVersion (): Promise<void> {
    try {
      const reply = await this.bridge.request('info', { type: 'version' }) as { rows?: readonly AboutRow[] } | undefined
      this.version = reply?.rows === undefined ? { state: 'error' } : { state: 'ready', value: reply.rows }
    } catch {
      this.version = { state: 'error' }
    }
    this.changed()
  }

  async loadGpu (): Promise<void> {
    this.gpu = { state: 'loading' }
    this.changed()
    try {
      const reply = await this.bridge.request('info', { type: 'gpu' }) as ({ ok: true } & GpuReport) | { ok: false } | undefined
      this.gpu = reply === undefined || !reply.ok ? { state: 'error' } : { state: 'ready', value: reply }
    } catch {
      this.gpu = { state: 'error' }
    }
    this.changed()
  }

  /** Whether main put the text on the clipboard. */
  async copy (what: 'version' | 'gpu'): Promise<boolean> {
    try {
      const reply = await this.bridge.request('info', { type: 'copy', what }) as { ok?: boolean } | undefined
      return reply?.ok === true
    } catch {
      return false
    }
  }
}
