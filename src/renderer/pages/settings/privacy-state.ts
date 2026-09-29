// What the page knows about how much is kept, and the one request that forgets
// it. Clearing is decided in main; this only sends the request and reports how
// it went. What is kept also changes while the page just sits there --
// browsing adds to history, a site remembers a zoom level -- so `handle`
// reloads on `privacy.changed` the same way `clear` already does after itself.
//
// `lastClear` holds what the "Clear browsing data" block should say, rather
// than the block setting its own DOM text imperatively: a push can redraw the
// whole section (clearing history is itself exactly such a push, landing back
// on the tab that asked), which would otherwise silently blank out the "it
// worked" message a moment after showing it. Reading it back from state on
// every redraw is what survives that.
import type { HistoryStatus } from '../../../main/history/history-service.js'
import type { ClearRequest, ClearResult } from '../../../main/privacy/clear-data.js'
import type { OrivonInternal } from '../shared/bridge.js'

export interface PrivacyStatus {
  readonly history: HistoryStatus
  /** How many sites have a zoom level of their own. */
  readonly zoomSites: number
}

export type ClearOutcome =
  | { readonly kind: 'nothing-chosen' }
  /** Main refused the request as malformed -- should not happen from this page's own UI, but the transport is not trusted either way. */
  | { readonly kind: 'refused' }
  | { readonly kind: 'ok' }
  | { readonly kind: 'failed', readonly names: readonly string[] }

export class PrivacyState {
  status: PrivacyStatus | null = null
  lastClear: ClearOutcome | null = null

  constructor (private readonly bridge: OrivonInternal, private readonly changed: () => void) {}

  async load (): Promise<void> {
    this.status = await this.bridge.request('privacy', { type: 'status' }) as PrivacyStatus
  }

  /** True once this was for a `privacy.changed` push. */
  handle (topic: string): boolean {
    if (topic !== 'privacy.changed') return false
    void this.load().then(() => { this.changed() })
    return true
  }

  /** The click handler's own client-side check, recorded the same way a real
   * clear's outcome is so it survives a redraw no differently. */
  nothingChosen (): void {
    this.lastClear = { kind: 'nothing-chosen' }
    this.changed()
  }

  async clear (request: ClearRequest): Promise<void> {
    const result = await this.bridge.request('privacy', { type: 'clear', request }) as ClearResult | undefined
    this.lastClear = result === undefined
      ? { kind: 'refused' }
      : result.ok ? { kind: 'ok' } : { kind: 'failed', names: result.failed }
    await this.load()
    this.changed()
  }
}
