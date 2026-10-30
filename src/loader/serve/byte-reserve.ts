// How many bytes of files held whole, to be hashed before they are sent, one app's handler may have in flight at once.
// A page opens many requests together; this keeps their sum bounded, taking bytes as they arrive, so a large cold file
// does not keep the scripts beside it from being served. Readers wait in a line, oldest first, and the oldest may go one
// file past the total, so some file can always be finished.

const POLL_MS = 25

/** Waits `ms`, or returns early once `signal` aborts; the caller checks `signal` itself. */
async function pause (ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const onAbort = (): void => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

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
   * True once `bytes` are held; false when `reader` is refused, or `left` aborts first.
   *
   * The oldest reader in line may hold up to `total` plus one file; every other reader, up to `total`. Only the oldest is ever
   * refused, and only when nothing has been taken or given for `waitMs`. A later reader has no timer: it waits until it finds
   * room or becomes the oldest, because the reader ahead of it may only have a slow source, which is no reason to lose its file.
   *
   * Why: files that each hold part of `total` wait for room only a finished file frees. The oldest has one file of slack, so
   * it always finishes, and what it gives back lets the next in line do the same.
   */
  async take (bytes: number, waitMs: number, reader: symbol, left: AbortSignal): Promise<boolean> {
    let seen = this.#moves
    let since = Date.now()
    while (!left.aborted) {
      const oldest = this.#line[0] === reader
      if (this.#held + bytes <= (oldest ? this.total + this.oneFile : this.total)) {
        this.#held += bytes
        this.#moves++
        return true
      }
      if (!oldest || this.#moves !== seen) {
        seen = this.#moves
        since = Date.now()
      } else if (Date.now() - since >= waitMs) {
        return false
      }
      await pause(POLL_MS, left)
    }
    return false
  }

  give (bytes: number): void {
    if (bytes > 0) this.#moves++
    this.#held = Math.max(0, this.#held - bytes)
  }
}
