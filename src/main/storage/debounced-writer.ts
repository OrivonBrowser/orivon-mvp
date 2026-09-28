// Batches rapid changes into one disk write, never runs two writes at once,
// and lets a caller wait until everything up to now is on disk. Each store
// that persists a small file (bookmarks, settings, zoom levels) supplies the
// write itself; the timing lives here once.

/** Batches rapid changes into one write instead of one per change. */
export const WRITE_DEBOUNCE_MS = 300

export class DebouncedWriter {
  // Every writer ever constructed, so quit can flush them all without holding
  // a reference to any. A writer whose store is gone flushes to nothing.
  private static readonly instances = new Set<DebouncedWriter>()

  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private pendingWrite: Promise<void> | null = null
  private resolvePendingWrite: (() => void) | null = null
  private rejectPendingWrite: ((error: unknown) => void) | null = null
  // At most one write may run at a time -- see runWrite.
  private writeInFlight = false
  // Set when a change arrives while a write is already running, so that
  // write's completion starts another pass over the now-current state instead
  // of the caller starting a second, concurrent write.
  private rerunRequested = false

  /** `writeNow` reads the store's current state when it starts and writes it. */
  constructor (
    private readonly writeNow: () => Promise<void>,
    private readonly debounceMs: number = WRITE_DEBOUNCE_MS
  ) {
    DebouncedWriter.instances.add(this)
  }

  /** Flushes every writer constructed so far. Never rejects: a write that
   * failed is the store's to report, and one slow or failed writer must not
   * stop this from settling for the others. Callers that need a bound on how
   * long this can take (before quitting) apply their own timeout. */
  static async flushAll (): Promise<void> {
    await Promise.allSettled([...DebouncedWriter.instances].map((writer) => writer.flush()))
  }

  /** A change is waiting to be written. */
  schedule (): void {
    if (this.writeTimer !== null) clearTimeout(this.writeTimer)
    // Created once per burst and reused across however many times the timer
    // is reset, rather than replaced on each change: a caller already
    // awaiting an earlier promise would otherwise wait on one whose only
    // resolver `clearTimeout` just cancelled.
    if (this.pendingWrite === null) {
      this.pendingWrite = new Promise((resolve, reject) => {
        this.resolvePendingWrite = resolve
        this.rejectPendingWrite = reject
      })
      // Nothing observes a rejection unless a caller awaits flush(). Without
      // this, a failed write with nobody listening would print an
      // unhandled-rejection warning on top of the store's own report.
      this.pendingWrite.catch(() => {})
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      this.runWrite()
    }, this.debounceMs)
  }

  /** Resolves once the file reflects every change made up to this call --
   * through the debounce window, through a write already in flight, and
   * through any further write that write's completion triggers because the
   * state changed again while it ran. Rejects with what the write threw if
   * the write that settles this call failed, so a failed write is never
   * reported as landed. Resolves at once when nothing is pending. */
  async flush (): Promise<void> {
    await this.pendingWrite
  }

  /** Starts a write, unless one is already running -- then it only records
   * that the state has changed again and leaves the running write alone.
   * Two overlapping writes can land in either order, so whichever finishes
   * last would win even when it started from the staler state; a change that
   * arrives mid-write is folded into the NEXT write, which reads the state
   * fresh when it starts. */
  private runWrite (): void {
    if (this.writeInFlight) {
      this.rerunRequested = true
      return
    }
    this.writeInFlight = true
    void this.writeNow().then(
      () => { this.afterWrite(null) },
      (error: unknown) => { this.afterWrite(error) }
    )
  }

  /** If the state changed while a write ran, that change is not on disk yet
   * even if the write succeeded: run again at once (the debounce batches
   * changes before a write starts, it does not delay one a change is already
   * waiting on). Otherwise this was the last write of the burst: settle. */
  private afterWrite (error: unknown): void {
    this.writeInFlight = false
    if (this.rerunRequested) {
      this.rerunRequested = false
      this.runWrite()
      return
    }
    this.settleWrite(error)
  }

  /** The only place `pendingWrite` is resolved or rejected. `writeTimer` may
   * still be running: a change can reach `schedule` (queuing a fresh timer)
   * while a write is in flight and before it finishes and finds
   * `rerunRequested` false, because that timer has not fired yet. Settling
   * anyway would resolve the caller before the queued write has happened, so
   * this waits for the timer too. */
  private settleWrite (error: unknown): void {
    if (this.writeTimer !== null || this.writeInFlight) return
    const resolve = this.resolvePendingWrite
    const reject = this.rejectPendingWrite
    this.pendingWrite = null
    this.resolvePendingWrite = null
    this.rejectPendingWrite = null
    if (error !== null) {
      if (reject !== null) reject(error)
    } else if (resolve !== null) {
      resolve()
    }
  }
}
