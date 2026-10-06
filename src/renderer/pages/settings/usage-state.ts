// Usage statistics as the page knows them: whether they are on, the exact text of the two reports that
// would be sent, what has been, and the actions the person can take. The page shows main's words and
// payloads as they are: nothing here decides or rounds anything. `sent` grows in the background as the
// telemetry runner actually sends; `handle` reloads on `usage.changed` rather than polling for that.
import type { OrivonInternal } from '../shared/bridge.js'

export interface UsageStatus {
  readonly private: boolean
  /** Why telemetry does not run in this build or launch: nothing is counted, so nothing can be turned on. */
  readonly off?: 'env' | 'private'
  readonly consent?: 'undecided' | 'accepted' | 'declined'
  readonly region?: string
  /** Whether anything was ever sent from this computer: with no acceptance there is nothing to delete. */
  readonly everAccepted?: boolean
  /** Null until telemetry is on: the computer is not read before then. */
  readonly installId?: string | null
  readonly usage?: unknown
  readonly sites?: unknown
  readonly sent?: ReadonlyArray<{ readonly payload: unknown, readonly sentAtMs: number }>
}

export type EraseOutcome = 'working' | 'done' | 'failed' | 'nothing'

export class UsageState {
  status: UsageStatus | null = null
  /** The result of the last Delete my data, until the next change of any kind. */
  erase: EraseOutcome | null = null
  noticeOpen = false
  private loading = false

  constructor (private readonly bridge: OrivonInternal, private readonly changed: () => void) {}

  /** True once this was for a `usage.changed` push. */
  handle (topic: string): boolean {
    if (topic !== 'usage.changed') return false
    void this.load()
    return true
  }

  async load (): Promise<void> {
    if (this.loading) return
    this.loading = true
    try {
      this.status = await this.bridge.request('telemetry', { type: 'status' }) as UsageStatus
    } finally {
      this.loading = false
    }
    this.changed()
  }

  async setOn (on: boolean): Promise<void> {
    this.erase = null
    await this.bridge.request('telemetry', { type: 'set', on })
    await this.load()
  }

  async deleteMyData (): Promise<void> {
    this.erase = 'working'
    this.changed()
    const reply = await this.bridge.request('telemetry', { type: 'erase' }) as { ok?: boolean, nothing?: boolean } | undefined
    this.erase = reply?.ok === true ? 'done' : reply?.nothing === true ? 'nothing' : 'failed'
    await this.load()
  }

  toggleNotice (): void {
    this.noticeOpen = !this.noticeOpen
    this.changed()
  }
}
