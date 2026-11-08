// What a request does while Chromium's network service is being replaced. The service is a process of its own; when it
// ends, the next one starts with none of what Orivon had set on the old one (the certificate check, secure DNS), and a
// request that reaches certificate verification or DNS before those are set again is judged by the defaults. A refused
// certificate stays refused: the network service caches the verdict for the host above whatever verifier is set later.
// So a request waits from the moment the service is gone until the settings are back, and no longer than a bound.
// Pure: the Electron half is network-service-runner.ts.

/** The `serviceName` Chromium reports for the network service in `child-process-gone`. */
export const NETWORK_SERVICE_NAME = 'network.mojom.NetworkService'

/** Whether a `child-process-gone` is the network service's. */
export function isNetworkServiceEnd (details: { readonly type: string, readonly serviceName?: string | undefined }): boolean {
  return details.type === 'Utility' && details.serviceName === NETWORK_SERVICE_NAME
}

/** How a hold ended. */
export type HoldOutcome = 'reapplied' | 'timed-out'

export interface HoldReport {
  readonly outcome: HoldOutcome
  /** From the service ending to the hold ending. */
  readonly heldMs: number
  /** The requests that waited. */
  readonly requests: number
}

/** A service that keeps ending cannot hold requests for ever: the whole hold lasts at most this many bounds. */
const MAX_BOUNDS = 3

/** What the restarts of the network service cost, counted for the whole run. */
export interface RestartCounts {
  /** Times the service ended. */
  readonly restarts: number
  /** Holds that ended at the bound, with the settings not yet back. */
  readonly timedOut: number
  /** How the latest hold ended, or `none` when the service has not ended. */
  readonly last: HoldOutcome | 'none'
}

export interface RestartDeps {
  readonly now: () => number
  /** The longest a request waits for the settings to come back. */
  readonly boundMs: number
  readonly ended: (report: HoldReport) => void
}

export class NetworkServiceRestart {
  private holding = false
  private since = 0
  private requests = 0
  private generation = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly waiting = new Set<() => void>()
  private count = 0
  private expired = 0
  private latest: HoldOutcome | 'none' = 'none'

  constructor (private readonly deps: RestartDeps) {}

  /**
   * The service ended: requests wait from now on. Returns the number to hand back to `reapplied`. A second end during a
   * hold starts the bound again, since the settings must be sent to the process that is now running, up to
   * `MAX_BOUNDS` bounds in all.
   */
  gone (): number {
    this.generation += 1
    this.count += 1
    if (!this.holding) {
      this.holding = true
      this.since = this.deps.now()
      this.requests = 0
    }
    clearTimeout(this.timer)
    const mine = this.generation
    const left = this.since + this.deps.boundMs * MAX_BOUNDS - this.deps.now()
    this.timer = setTimeout(() => { this.finish('timed-out', mine) }, Math.max(0, Math.min(this.deps.boundMs, left)))
    return mine
  }

  /** Whether no later end has superseded `generation`: only the current one sends the settings. */
  isCurrent (generation: number): boolean {
    return generation === this.generation
  }

  /**
   * The settings were sent to the running service. False when a later end has superseded this one, in which case
   * the later one's own `reapplied` ends the hold.
   */
  reapplied (generation: number): boolean {
    if (!this.isCurrent(generation)) return false
    if (this.holding) this.finish('reapplied', generation)
    return true
  }

  /** Resolves at once unless the service is gone and its settings are not back; then when they are, or the bound passes. */
  async whenOpen (): Promise<void> {
    if (!this.holding) return
    this.requests += 1
    await new Promise<void>((resolve) => { this.waiting.add(resolve) })
  }

  isHolding (): boolean {
    return this.holding
  }

  counts (): RestartCounts {
    return { restarts: this.count, timedOut: this.expired, last: this.latest }
  }

  private finish (outcome: HoldOutcome, generation: number): void {
    if (generation !== this.generation || !this.holding) return
    clearTimeout(this.timer)
    this.timer = undefined
    this.holding = false
    if (outcome === 'timed-out') this.expired += 1
    this.latest = outcome
    const report: HoldReport = { outcome, heldMs: this.deps.now() - this.since, requests: this.requests }
    const release = [...this.waiting]
    this.waiting.clear()
    for (const resolve of release) resolve()
    this.deps.ended(report)
  }
}
