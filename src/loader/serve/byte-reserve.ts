// How many bytes of files held whole, to be hashed before they are sent, one app's handler may have in flight at once.
// A page opens many requests together; this keeps their sum bounded, taking bytes as they arrive, so a large cold file
// does not keep the scripts beside it from being served: such a script waits only while the reserve keeps moving, and
// is refused when it stops. Readers wait in a line, oldest first, and the oldest may go one file past the total.

const POLL_MS = 25

export class ByteReserve {
  #held = 0
  /** Every take and every non-empty give: a take and a give of equal size leave `#held` where it was, and still moved. */
  #moves = 0
  readonly #line: symbol[] = []

  /** `oneFile` is the most one reader's file may hold: the oldest reader may go that far past `total`. */
  constructor (private readonly total: number, private readonly oneFile: number) {}

  /** Joins the line behind every reader already in it. */
  enter (): symbol {
    const reader = Symbol('reader')
    this.#line.push(reader)
    return reader
  }

  /** Leaves the line, as a reader does once its file is gathered. A reader that has left leaves again harmlessly. */
  leave (reader: symbol): void {
    const at = this.#line.indexOf(reader)
    if (at >= 0) this.#line.splice(at, 1)
  }

  /**
   * True once `bytes` are held; false when `reader` is refused. The oldest reader in line may hold up to `total` plus one
   * file, every other reader up to `total`. Any reader is refused once nothing has been taken or given for `waitMs`, which
   * is as long as a stalled file can keep the others waiting. Why the oldest has the slack: this folder's `README.md`, Design notes.
   */
  async take (bytes: number, waitMs: number, reader: symbol): Promise<boolean> {
    let seen = this.#moves
    let since = Date.now()
    for (;;) {
      if (this.#held + bytes <= (this.#line[0] === reader ? this.total + this.oneFile : this.total)) {
        this.#held += bytes
        this.#moves++
        return true
      }
      if (this.#moves !== seen) {
        seen = this.#moves
        since = Date.now()
      } else if (Date.now() - since >= waitMs) {
        return false
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
  }

  give (bytes: number): void {
    if (bytes > 0) this.#moves++
    this.#held = Math.max(0, this.#held - bytes)
  }
}
