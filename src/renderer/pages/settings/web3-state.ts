// How the Ethereum light client is doing, in the words main gives, kept in step
// as it changes while the page is open. The page reads and never asks it to do
// anything but start again with the choice made.
import type { LightClientView } from '../../../main/verifier/status-view.js'
import type { OrivonInternal } from '../shared/bridge.js'

interface Status {
  readonly view: LightClientView
  readonly enabled: boolean
  readonly enabledAtStart: boolean
  readonly forcedOff: boolean
}

export class Web3State {
  status: Status | null = null

  constructor (private readonly bridge: OrivonInternal) {}

  async load (): Promise<void> {
    this.status = await this.bridge.request('web3', { type: 'status' }) as Status
  }

  /** The light client changed while the page is open. True when this was for it. */
  handle (topic: string, payload: unknown): boolean {
    if (topic !== 'web3.changed' || this.status === null) return false
    this.status = { ...this.status, view: payload as LightClientView }
    return true
  }

  /** The choice is not what this run started with: a restart is waiting. */
  needsRestart (enabledNow: boolean): boolean {
    return this.status !== null && enabledNow !== this.status.enabledAtStart
  }

  async relaunch (): Promise<{ ok: boolean }> {
    return await this.bridge.request('app', { type: 'relaunch' }) as { ok: boolean }
  }
}
