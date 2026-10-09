// How many bytes of files held whole, to be hashed before they are sent, one app's handler may have in flight at once.
// A page opens many requests together; this keeps their sum bounded, taking bytes as they arrive, so a large cold file
// does not keep the scripts beside it from being served.

const POLL_MS = 25

export class ByteReserve {
  #held = 0

  constructor (private readonly total: number) {}

  /** True once `bytes` are held, waiting up to `waitMs` for others to give theirs back; false when none came free in time. */
  async take (bytes: number, waitMs: number): Promise<boolean> {
    const until = Date.now() + waitMs
    while (this.#held + bytes > this.total) {
      if (Date.now() >= until) return false
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
    this.#held += bytes
    return true
  }

  give (bytes: number): void {
    this.#held = Math.max(0, this.#held - bytes)
  }
}
