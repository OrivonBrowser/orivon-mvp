// A transfer that fails when it stops moving, not when a clock written for a fast connection runs out.

/** What ended a transfer that did not finish. */
export type StallReason = 'first-byte' | 'stall' | 'cap'

export interface StallWindows {
  /** How long the answer's first byte may take. */
  readonly firstByteMs: number
  /** How long the body may go without a byte once the answer has begun. */
  readonly stallMs: number
  /** The outer cap on the whole transfer, so a source that trickles for ever still ends. */
  readonly capMs: number
}

/**
 * One transfer's clock: `signal` aborts when the first byte takes longer than `firstByteMs`, when the body
 * then goes `stallMs` with no byte (`progress` restarts that window), or when the whole transfer passes `capMs`.
 * `reason` says which. `finish` stops the clock; call it when the transfer ends however it ends.
 */
export class StallClock {
  private readonly controller = new AbortController()
  private window: ReturnType<typeof setTimeout> | undefined
  private readonly cap: ReturnType<typeof setTimeout>
  private began = false
  private reasonFired: StallReason | undefined

  constructor (private readonly windows: StallWindows) {
    this.arm(windows.firstByteMs, 'first-byte')
    this.cap = setTimeout(() => { this.fire('cap') }, windows.capMs)
  }

  get signal (): AbortSignal {
    return this.controller.signal
  }

  get reason (): StallReason | undefined {
    return this.reasonFired
  }

  /** The answer began (its headers arrived), or another chunk of its body did. */
  progress (): void {
    if (this.controller.signal.aborted) return
    this.began = true
    this.arm(this.windows.stallMs, 'stall')
  }

  finish (): void {
    clearTimeout(this.window)
    clearTimeout(this.cap)
  }

  private arm (ms: number, reason: StallReason): void {
    clearTimeout(this.window)
    this.window = setTimeout(() => { this.fire(this.began ? 'stall' : reason) }, ms)
  }

  private fire (reason: StallReason): void {
    if (this.controller.signal.aborted) return
    this.reasonFired = reason
    this.finish()
    this.controller.abort(new DOMException(`no progress: ${reason}`, 'TimeoutError'))
  }
}
