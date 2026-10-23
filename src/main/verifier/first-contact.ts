// Which requests to a verifier-served host wait for the first connection to it. Pure: the subsystem feeds it
// the session's request events.

interface Pending {
  /** The request being waited for. */
  readonly leader: number
  /** Settles when the leader's connection is made, when it ends without one, at the bound, or on a reset. */
  readonly settled: Promise<void>
  readonly release: () => void
  readonly timer: ReturnType<typeof setTimeout>
}

export interface FirstContactOptions {
  /** The longest the others wait for the first request's connection. */
  readonly waitMs: number
  /** How long after a first connection another one is taken to resume its session: less than the verifier's session lifetime (300 s). */
  readonly warmMs: number
}

/**
 * Holds the requests to a host after the first until the first has made its connection, so the others resume
 * its TLS session instead of each being verified at once. See README.md's Design notes for why.
 */
export class FirstContact {
  private readonly pending = new Map<string, Pending>()
  private readonly warmUntil = new Map<string, number>()

  constructor (private readonly options: FirstContactOptions, private readonly now: () => number = Date.now) {}

  /** Resolves when request `id` to `host` may go on: at once for the first request or a host reached lately, else when the first one has connected. */
  async enter (host: string, id: number): Promise<void> {
    for (;;) {
      if (this.warm(host)) return
      const held = this.pending.get(host)
      if (held === undefined) {
        this.lead(host, id)
        return
      }
      if (held.leader === id) return
      await held.settled
    }
  }

  /** A request to `host` has made its connection and is sending: the host's certificate is verified and its session is kept. */
  reached (host: string): void {
    const held = this.pending.get(host)
    if (held === undefined) return
    this.warmUntil.set(host, this.now() + this.options.warmMs)
    this.settle(host, held)
  }

  /** A request ended, however it ended; the first one ending before its connection hands the lead to the next. */
  ended (host: string, id: number): void {
    const held = this.pending.get(host)
    if (held?.leader === id) this.settle(host, held)
  }

  /** The host's certificate changed, or its sessions were dropped: nothing is known of any host, and nobody waits. */
  reset (): void {
    this.warmUntil.clear()
    for (const [host, held] of [...this.pending]) this.settle(host, held)
  }

  private warm (host: string): boolean {
    const until = this.warmUntil.get(host)
    if (until === undefined) return false
    if (this.now() < until) return true
    this.warmUntil.delete(host)
    return false
  }

  private lead (host: string, id: number): void {
    let release: () => void = () => {}
    const settled = new Promise<void>((resolve) => { release = resolve })
    // A first request that never connects does not hold the others for ever; they go on, and the host is not held again until its warm time has passed.
    const timer = setTimeout(() => {
      const held = this.pending.get(host)
      if (held === undefined) return
      this.warmUntil.set(host, this.now() + this.options.warmMs)
      this.settle(host, held)
    }, this.options.waitMs)
    this.pending.set(host, { leader: id, settled, release, timer })
  }

  private settle (host: string, held: Pending): void {
    clearTimeout(held.timer)
    if (this.pending.get(host) === held) this.pending.delete(host)
    held.release()
  }
}
