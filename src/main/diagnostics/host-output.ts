// What a utility process prints becomes lines of the main process's own log. Each line a host writes is handed to
// the console sink, which is the console main's log is captured from, so the ring, `logs/current.log` and a bug report
// hold it as they hold any line of main's. Pure: the streams, the clock and the console are passed in.
import { StringDecoder } from 'node:string_decoder'
import { LOG_LINE_LIMIT } from './log-ring.js'

/** The most lines of one host that reach the log in a minute (more are counted, and one line says how many). The ring holds 1000 lines in all. */
export const HOST_LINES_PER_MINUTE = 60

const WINDOW_MS = 60_000
/** A line with no newline in it this long is written as it stands, so a host that never ends a line cannot grow main's memory. */
const MAX_UNFINISHED = 4 * LOG_LINE_LIMIT

export type HostLevel = 'log' | 'warn'

/** The slice of a child's `stdout` or `stderr` this file listens to. */
export interface OutputStream {
  on: (event: string, listener: (chunk?: Buffer | string) => void) => unknown
}

/** The slice of Electron's UtilityProcess this file uses. Its streams are null unless it was forked with piped output. */
export interface HostChild {
  readonly stdout?: OutputStream | null
  readonly stderr?: OutputStream | null
  on: (event: 'exit', listener: (code: number) => void) => unknown
}

export interface HostLogOptions {
  /** How the host's own lines begin (`[verifier]`): a line that does not begin so gets it put in front. */
  readonly prefix: string
  /** Where a line goes: main's console. */
  readonly write: (level: HostLevel, text: string) => void
  /** The most lines a minute that are written; undefined writes all of them. */
  readonly linesPerMinute?: number | undefined
  readonly now?: () => number
  readonly setTimer?: (callback: () => void, ms: number) => unknown
}

/**
 * One host's output as lines of main's log, across every process the host is forked as. A stream is always read to
 * its end, whatever is written of it: a pipe nobody empties stops the host that writes to it.
 */
export class HostLog {
  private windowStart: number | undefined
  private kept = 0
  private dropped = 0
  private timer: unknown
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, ms: number) => unknown

  constructor (private readonly options: HostLogOptions) {
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((callback, ms) => {
      const timer = setTimeout(callback, ms)
      timer.unref()
      return timer
    })
  }

  /** Starts reading a freshly forked child's output. A child forked without piped output has nothing to read. */
  attach (child: HostChild): void {
    const ends = [this.listen(child.stdout, 'log'), this.listen(child.stderr, 'warn')]
    child.on('exit', () => { for (const end of ends) end() })
  }

  /** Reads one stream; returns what writes the line it is still waiting to see the end of. */
  private listen (stream: OutputStream | null | undefined, level: HostLevel): () => void {
    if (stream === null || stream === undefined) return () => {}
    const decoder = new StringDecoder('utf8')
    let unfinished = ''
    stream.on('data', (chunk) => {
      if (chunk === undefined) return
      const lines = (unfinished + (typeof chunk === 'string' ? chunk : decoder.write(chunk))).split(/\r?\n/)
      unfinished = lines.pop() ?? ''
      if (unfinished.length > MAX_UNFINISHED) {
        lines.push(unfinished)
        unfinished = ''
      }
      this.emit(level, lines)
    })
    const end = (): void => {
      const rest = unfinished + decoder.end()
      unfinished = ''
      this.emit(level, [rest])
    }
    stream.on('end', end)
    return end
  }

  /** The lines of one read, as the entries they are: an indented line goes on the entry before it (a stack stays under its first line). */
  private emit (level: HostLevel, lines: readonly string[]): void {
    const entries: string[][] = []
    for (const raw of lines) {
      const line = raw.trimEnd()
      if (line === '') continue
      const cut = line.length > LOG_LINE_LIMIT ? line.slice(0, LOG_LINE_LIMIT) : line
      const last = entries.at(-1)
      if (last !== undefined && /^\s/.test(cut)) last.push(cut)
      else entries.push([cut])
    }
    for (const entry of entries) {
      if (!this.admit(entry.length)) continue
      const [first = '', ...rest] = entry
      const head = first.startsWith(this.options.prefix) ? first : `${this.options.prefix} ${first}`
      this.options.write(level, [head, ...rest].join('\n'))
    }
  }

  /** Whether an entry of `count` lines is written: once the minute's allowance is used, the rest of the minute is only counted. An entry is never cut, so one longer than the allowance still passes when nothing else did. */
  private admit (count: number): boolean {
    const limit = this.options.linesPerMinute
    if (limit === undefined) return true
    const at = this.now()
    if (this.windowStart !== undefined && at - this.windowStart >= WINDOW_MS) this.closeWindow()
    this.windowStart ??= at
    if (this.kept < limit) {
      this.kept += count
      return true
    }
    this.dropped += count
    const started = this.windowStart
    // The count is said when the minute ends, even if the host writes nothing more.
    this.timer ??= this.setTimer(() => { if (this.windowStart === started) this.closeWindow() }, Math.max(0, WINDOW_MS - (at - started)))
    return false
  }

  private closeWindow (): void {
    const dropped = this.dropped
    this.windowStart = undefined
    this.kept = 0
    this.dropped = 0
    this.timer = undefined
    if (dropped > 0) this.options.write('warn', `${this.options.prefix} ${String(dropped)} more lines in the last minute were not kept (at most ${String(this.options.linesPerMinute)} a minute are)`)
  }
}
