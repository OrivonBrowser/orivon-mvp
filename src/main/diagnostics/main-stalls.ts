// How long the main process stopped answering, read from how late a repeating timer fires. Pure: the clock and the
// log line come in as arguments, and diagnostics-runner.ts is what starts the timer.
//
// A timer reads a stall as the delay between when it was due and when it ran, so it undercounts a stall by at most
// one interval and has a time for each one, which `monitorEventLoopDelay`'s histogram (percentiles over a window)
// does not give, and a count past a threshold needs that.

/** What the main process's stalls came to: counts and one duration, never a page or an address. */
export interface StallCounts {
  /** Stalls of 1 second or more. */
  readonly over1s: number
  /** Stalls of 5 seconds or more; they are also in `over1s`. */
  readonly over5s: number
  /** The longest stall, in whole milliseconds. */
  readonly longestMs: number
}

export const NO_STALLS: StallCounts = { over1s: 0, over5s: 0, longestMs: 0 }

export const STALL_TICK_MS = 500
export const STALL_MS = 1000
export const LONG_STALL_MS = 5000
/** A stall at least this long gets a line in the log. */
export const LOGGED_STALL_MS = 2000
/** At most this many stall lines a minute: a main process that keeps stalling must not fill the log's 1000 lines, and the counts still hold every stall. */
export const STALL_LINES_PER_MINUTE = 6
/** A delay this long is the computer asleep, not the process stalled. */
export const MAX_STALL_MS = 10 * 60_000
const MINUTE_MS = 60_000

export interface StallDeps {
  /** A clock that does not jump with the wall clock. */
  readonly now: () => number
  readonly log: (line: string) => void
}

export class StallMonitor {
  private last: number
  private over1s = 0
  private over5s = 0
  private longestMs = 0
  private loggable = 0
  private minuteStart = 0
  private linesThisMinute = 0

  constructor (private readonly deps: StallDeps) {
    this.last = deps.now()
  }

  /** Called every `STALL_TICK_MS` by a timer; how late this call is, beyond the interval, is the stall. */
  tick (): void {
    const at = this.deps.now()
    const stall = Math.round(at - this.last - STALL_TICK_MS)
    this.last = at
    if (stall < STALL_MS || stall >= MAX_STALL_MS) return
    this.over1s += 1
    if (stall >= LONG_STALL_MS) this.over5s += 1
    this.longestMs = Math.max(this.longestMs, stall)
    if (stall >= LOGGED_STALL_MS) this.logStall(at, stall)
  }

  counts (): StallCounts {
    return { over1s: this.over1s, over5s: this.over5s, longestMs: this.longestMs }
  }

  private logStall (at: number, stall: number): void {
    this.loggable += 1
    if (at - this.minuteStart >= MINUTE_MS) {
      this.minuteStart = at
      this.linesThisMinute = 0
    }
    if (this.linesThisMinute >= STALL_LINES_PER_MINUTE) return
    this.linesThisMinute += 1
    this.deps.log(`[orivon] The main process did not answer for about ${(stall / 1000).toFixed(1)} s (stall ${String(this.loggable)} of ${String(LOGGED_STALL_MS / 1000)} s or more in this run).`)
  }
}
