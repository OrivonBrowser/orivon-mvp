// The apps as the page knows them: a switch for each thing one may do, the
// files it was given, what it has stored, and whether the identity key is kept.
// A switch goes through main, which checks the request; the list is fetched
// again after, so the page never shows a permission main no longer has. A
// grant or revoke made elsewhere (the site-info popover, another Settings
// window, install) arrives as `apps.changed` and reloads the same way.
import type { OrivonInternal } from '../shared/bridge.js'
import { coalesce } from '../shared/coalesce.js'

export interface AppRow {
  readonly origin: string
  readonly appName: string
  /** One row per capability the app declares or holds, each with the switch that moves it. */
  readonly capabilityRows: ReadonlyArray<CapabilityRow>
  readonly pickedPathRows: ReadonlyArray<{ readonly pickId: string, readonly kind: string, readonly warning: boolean, readonly message: string }>
  readonly deviceRows: ReadonlyArray<{ readonly key: string, readonly label: string }>
  /** The kinds of link the person chose this app to open (`magnet`), each shown with a switch that takes it back. */
  readonly linkSchemes: readonly string[]
  readonly storage: { readonly filesBytes: number, readonly codeBytes: number }
  /** The switch that sends the app's traffic through the person's proxy: what its route is doing, and why it cannot be turned on. */
  readonly route: { readonly state: RouteView, readonly blocked: 'no-proxy' | 'not-cached' | undefined, readonly unreadable?: boolean }
}

export interface CapabilityRow {
  readonly capability: string
  readonly on: boolean
  /** False for an off row that cannot be turned on from here: the app is not open, so its manifest cannot bound a grant. */
  readonly canTurnOn: boolean
  readonly warning: boolean
  readonly message: string
  /** What turning the row on would grant, sent back so main can tell the manifest moved since the row was drawn. */
  readonly patterns: readonly string[]
}

export type RouteView = 'off' | 'no-proxy' | 'idle' | 'ok' | 'down'

export type IdentityStorage = 'keychain' | 'session-only' | 'not-started'

export class AppsState {
  apps: readonly AppRow[] | null = null
  identity: IdentityStorage = 'not-started'
  private loading = false
  private readonly reload: () => void

  constructor (private readonly bridge: OrivonInternal, private readonly changed: () => void) {
    // A bulk revoke or an install granting several capabilities at once
    // fires `apps.changed` once per grant -- coalesced so it costs one
    // refetch, not one per grant.
    this.reload = coalesce(() => { void this.load() })
  }

  /** True once this was for an `apps.changed` push. */
  handle (topic: string): boolean {
    if (topic !== 'apps.changed') return false
    this.reload()
    return true
  }

  /** Asks for the list once; a second call while one is under way does nothing. */
  async load (): Promise<void> {
    if (this.loading) return
    this.loading = true
    try {
      const reply = await this.bridge.request('apps', { type: 'list' }) as { apps: readonly AppRow[], identity: IdentityStorage }
      this.apps = reply.apps
      this.identity = reply.identity
    } finally {
      this.loading = false
    }
    this.changed()
  }

  /** Capabilities whose last switch was refused, by the way it was moved (true: on), so the row can say what could not be done until the next press. */
  readonly capabilityRefused = new Map<string, boolean>()

  async setCapability (origin: string, row: CapabilityRow, on: boolean): Promise<void> {
    const key = `${origin}|${row.capability}`
    this.capabilityRefused.delete(key)
    try {
      const reply = await this.bridge.request('apps', { type: 'setCapability', origin, capability: row.capability, on, patterns: row.patterns }) as { ok?: unknown } | undefined
      if (reply?.ok !== true) this.capabilityRefused.set(key, on)
    } catch {
      this.capabilityRefused.set(key, on)
    }
    await this.load()
  }

  async revokePickedPath (origin: string, pickId: string): Promise<void> {
    await this.bridge.request('apps', { type: 'revokePickedPath', origin, pickId })
    await this.load()
  }

  async forgetLink (origin: string, scheme: string): Promise<void> {
    await this.bridge.request('apps', { type: 'forgetLink', origin, scheme })
    await this.load()
  }

  /** Apps whose last switch of the route was refused (the proxy was cleared, or the app's files are gone), so the card can say so until the next press. */
  readonly routeRefused = new Set<string>()

  async setRoute (origin: string, routed: boolean): Promise<void> {
    this.routeRefused.delete(origin)
    try {
      const reply = await this.bridge.request('apps', { type: 'setRoute', origin, routed }) as { ok?: unknown } | undefined
      if (reply?.ok !== true) this.routeRefused.add(origin)
    } catch {
      this.routeRefused.add(origin)
    }
    await this.load()
  }

  async forgetDevice (origin: string, key: string): Promise<void> {
    await this.bridge.request('apps', { type: 'forgetDevice', origin, key })
    await this.load()
  }
}
