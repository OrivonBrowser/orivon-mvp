// Usage statistics as the page knows them: whether the person has chosen, the
// exact text that would be sent, and what has been. The page shows main's words
// and payload as they are: nothing here decides or rounds anything. `sent`
// grows in the background as the telemetry runner actually sends; `handle`
// reloads on `usage.changed` rather than polling for that.
import type { OrivonInternal } from '../shared/bridge.js'

export interface UsageStatus {
  readonly private: boolean
  readonly consent?: 'undecided' | 'accepted' | 'declined'
  readonly options?: ReadonlyArray<{ readonly id: string, readonly label: string, readonly resultingState: string }>
  readonly payload?: unknown
  readonly sent?: ReadonlyArray<{ readonly payload: unknown, readonly sentAtMs: number }>
}

export class UsageState {
  status: UsageStatus | null = null
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

  async decide (option: string): Promise<void> {
    await this.bridge.request('telemetry', { type: 'decide', option })
    await this.load()
  }
}
