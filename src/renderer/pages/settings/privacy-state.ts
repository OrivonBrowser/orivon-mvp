// What the page knows about how much is kept, and the one request that forgets
// it. Clearing is decided in main; this only sends the request and reports how
// it went.
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

  constructor (private readonly bridge: OrivonInternal) {}

  async load (): Promise<void> {
    this.status = await this.bridge.request('privacy', { type: 'status' }) as PrivacyStatus
  }

  /** Null when main refused the request as malformed. The page is not redrawn: the block that asked is showing how it went. */
  async clear (request: ClearRequest): Promise<ClearResult | null> {
    const result = await this.bridge.request('privacy', { type: 'clear', request }) as ClearResult | undefined
    await this.load()
    return result ?? null
  }
}
