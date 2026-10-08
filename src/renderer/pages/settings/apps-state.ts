// The apps that hold permissions, as the page knows them: what each may do, the
// files it was given, what it has stored, and whether the identity key is kept.
// Revoking goes through main, which checks the request; the list is fetched
// again after, so the page never shows a permission main no longer has. A
// grant or revoke made elsewhere (the site-info popover, another Settings
// window, install) arrives as `apps.changed` and reloads the same way.
import type { OrivonInternal } from '../shared/bridge.js'
import { coalesce } from '../shared/coalesce.js'

export interface AppRow {
  readonly origin: string
  readonly appName: string
  readonly rows: ReadonlyArray<{ readonly capability: string, readonly warning: boolean, readonly message: string }>
  readonly pickedPathRows: ReadonlyArray<{ readonly pickId: string, readonly kind: string, readonly warning: boolean, readonly message: string }>
  readonly deviceRows: ReadonlyArray<{ readonly key: string, readonly label: string }>
  readonly storage: { readonly filesBytes: number, readonly codeBytes: number }
}

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

  async revoke (origin: string, capability: string): Promise<void> {
    await this.bridge.request('apps', { type: 'revoke', origin, capability })
    await this.load()
  }

  async revokePickedPath (origin: string, pickId: string): Promise<void> {
    await this.bridge.request('apps', { type: 'revokePickedPath', origin, pickId })
    await this.load()
  }

  async forgetDevice (origin: string, key: string): Promise<void> {
    await this.bridge.request('apps', { type: 'forgetDevice', origin, key })
    await this.load()
  }
}
