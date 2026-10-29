// What a utility process prints becomes lines of the main process's own log. Each line a host writes is handed to
// the console sink, which is the console main's log is captured from, so the ring, `logs/current.log` and a bug report
// hold it as they hold any line of main's. Pure: the streams, the clock and the console are passed in.
import { StringDecoder } from 'node:string_decoder'
import { LOG_LINE_LIMIT } from './log-ring.js'

/** The most lines of one host that are written as they come in a minute (more are counted, and the last few are written when the minute ends). The ring holds 1000 lines in all. */
export const HOST_LINES_PER_MINUTE = 60

/** The entries of a minute's overflow that are kept and written when the minute ends. */
export const HOST_TAIL_ENTRIES = 5

const WINDOW_MS = 60_000
/** A stream that has not ended this long after its process exited is read as ended: Electron ends it itself, but a pipe held open by a grandchild would never end. */
const EXIT_GRACE_MS = 2000
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
  /** The most lines a minute that are written as they come; undefined writes all of them, repeats included. */
  readonly linesPerMinute?: number | undefined
  /**
   * For a host whose process also runs code that prints what it likes: set, only a line that begins with `prefix` is
   * written. The others are counted, and one line a minute says how many came from this (`the Nym library`).
   */
  readonly onlyTagged?: string | undefined
  readonly now?: () => number
  readonly setTimer?: (callback: () => void, ms: number) => unknown
}

/** One thing a host printed: a line and the indented lines under it. */
interface Entry {
  readonly level: HostLevel
  readonly text: string
  readonly lines: number
}

/** What reads one stream: `finish` writes the line it is still waiting to see the end of. */
interface Reader {
  readonly finish: () => void
  readonly ended: () => boolean
}

/**
 * One host's output as lines of main's log, across every process the host is forked as. A stream is always read to
 * its end, whatever is written of it: a pipe nobody empties stops the host that writes to it.
 */
export class HostLog {
  private windowStart: number | undefined
  /** Raised each time a minute closes, so a timer made for an earlier minute does nothing. */
  private minute = 0
  private kept = 0
  private previous: Entry | undefined
  private repeats = 0
  private dropped = 0
  private tail: Entry[] = []
  private untagged = 0
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
    const readers = [this.listen(child.stdout, 'log'), this.listen(child.stderr, 'warn')]
    // Electron ends the streams itself, and output can still be in the pipe when `exit` comes: a line is written when its stream ends.
    child.on('exit', () => {
      if (readers.every((reader) => reader.ended())) return
      this.setTimer(() => { for (const reader of readers) reader.finish() }, EXIT_GRACE_MS)
    })
  }

  /** Writes what is waiting for the minute's end: the repeat count, the count of lines held back with the last few of them, the count of lines left out. For when the app quits. */
  flush (): void {
    if (this.windowStart !== undefined) this.closeMinute()
  }

  private listen (stream: OutputStream | null | undefined, level: HostLevel): Reader {
    if (stream === null || stream === undefined) return { finish: () => {}, ended: () => true }
    const decoder = new StringDecoder('utf8')
    let unfinished = ''
    let ended = false
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
    const finish = (): void => {
      ended = true
      const rest = unfinished + decoder.end()
      unfinished = ''
      this.emit(level, [rest])
    }
    stream.on('end', finish)
    return { finish, ended: () => ended }
  }

  /** The lines of one read, as the entries they are: an indented line goes on the entry before it (a stack stays under its first line). A line is not cut here: the scrub of a noted key must see all of it, and the ring cuts after. */
  private emit (level: HostLevel, lines: readonly string[]): void {
    const entries: string[][] = []
    for (const raw of lines) {
      const line = raw.trimEnd()
      if (line === '') continue
      const last = entries.at(-1)
      if (last !== undefined && /^\s/.test(line)) last.push(line)
      else entries.push([line])
    }
    for (const entry of entries) this.accept(level, entry)
  }

  private accept (level: HostLevel, lines: readonly string[]): void {
    const { prefix, onlyTagged, linesPerMinute } = this.options
    const [first = '', ...rest] = lines
    const tagged = first.startsWith(prefix)
    const entry: Entry = { level, text: [tagged ? first : `${prefix} ${first}`, ...rest].join('\n'), lines: lines.length }
    if (!tagged && onlyTagged !== undefined) {
      this.untagged += entry.lines
      this.arm(this.openMinute())
    } else if (linesPerMinute === undefined) {
      this.write(entry)
    } else {
      this.cap(entry, linesPerMinute)
    }
  }

  /** Writes, collapses or holds back one entry against the minute's allowance. An entry is never cut, so one longer than the allowance still passes when nothing else did. */
  private cap (entry: Entry, limit: number): void {
    const started = this.openMinute()
    const { previous } = this
    if (previous !== undefined && previous.level === entry.level && previous.text === entry.text) {
      this.repeats += 1
      this.arm(started)
      return
    }
    this.settleRepeats()
    if (this.kept < limit) {
      this.kept += entry.lines
      this.previous = entry
      this.write(entry)
      return
    }
    this.previous = undefined
    if (this.dropped === 0) this.options.write('warn', `${this.options.prefix} more than ${String(limit)} lines this minute: the rest are counted, and the last ${String(HOST_TAIL_ENTRIES)} are written when the minute ends`)
    this.dropped += entry.lines
    this.tail.push(entry)
    if (this.tail.length > HOST_TAIL_ENTRIES) this.tail.shift()
    this.arm(started)
  }

  private write (entry: Entry): void {
    this.options.write(entry.level, entry.text)
  }

  /** The start of the minute an entry belongs to; a minute that has run out is closed first, so what it holds is said before the entry. */
  private openMinute (): number {
    const at = this.now()
    if (this.windowStart !== undefined && at - this.windowStart >= WINDOW_MS) this.closeMinute()
    this.windowStart ??= at
    return this.windowStart
  }

  /** The counts are said when the minute ends, even if the host writes nothing more. */
  private arm (started: number): void {
    const minute = this.minute
    this.timer ??= this.setTimer(() => { if (this.minute === minute) this.closeMinute() }, Math.max(0, WINDOW_MS - (this.now() - started)))
  }

  /** Says how many times the line last written was printed again. That line counts against the allowance like any, but is never refused. */
  private settleRepeats (): void {
    const { previous, repeats } = this
    this.repeats = 0
    if (previous === undefined || repeats === 0) return
    this.kept += 1
    this.options.write(previous.level, `${this.options.prefix} the line above repeated ${repeats === 1 ? 'once' : `${String(repeats)} times`}`)
  }

  private closeMinute (): void {
    const { prefix, linesPerMinute, onlyTagged } = this.options
    const { dropped, tail, untagged } = this
    this.settleRepeats()
    this.windowStart = undefined
    this.minute += 1
    this.timer = undefined
    this.kept = 0
    this.previous = undefined
    this.dropped = 0
    this.tail = []
    this.untagged = 0
    if (dropped > 0) {
      this.options.write('warn', `${prefix} ${dropped === 1 ? '1 more line' : `${String(dropped)} more lines`} came in the last minute after the first ${String(linesPerMinute)}; ${tail.length === 1 ? 'the last entry of them follows' : `the last ${String(tail.length)} entries of them follow`}`)
      for (const entry of tail) this.write(entry)
    }
    if (untagged > 0) this.options.write('warn', `${prefix} ${untagged === 1 ? '1 line' : `${String(untagged)} lines`} from ${onlyTagged ?? 'elsewhere'} ${untagged === 1 ? 'was' : 'were'} left out in the last minute`)
  }
}
