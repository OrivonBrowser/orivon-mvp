// What the page knows about how much is kept, and the one request that forgets
// it. Clearing is decided in main; this only sends the request and reports how
// it went. What is kept also changes while the page just sits there --
// browsing adds to history, a site remembers a zoom level -- so `handle`
// reloads on `privacy.changed` the same way `clear` already does after itself.
import type { HistoryStatus } from '../../../main/history/history-service.js'
import type { ClearRequest, ClearResult } from '../../../main/privacy/clear-data.js'
import type { OrivonInternal } from '../shared/bridge.js'

export interface PrivacyStatus {
  readonly history: HistoryStatus
  /** How many sites have a zoom level of their own. */
  readonly zoomSites: number
}

export class PrivacyState {
  status: PrivacyStatus | null = null

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

  /** Null when main refused the request as malformed. The page is not redrawn: the block that asked is showing how it went. */
  async clear (request: ClearRequest): Promise<ClearResult | null> {
    const result = await this.bridge.request('privacy', { type: 'clear', request }) as ClearResult | undefined
    await this.load()
    return result ?? null
  }
}
