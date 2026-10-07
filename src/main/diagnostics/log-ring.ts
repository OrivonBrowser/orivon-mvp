// The main process's own log: every console line, newest 1000 kept in memory for a report, each stamped with
// the time and the level. Lines still print as before; this only remembers them.
import { format } from 'node:util'

export const LOG_RING_LINES = 1000
export const LOG_LINE_LIMIT = 2000

export const LOG_LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

const CONTINUATION = '    '

function cut (line: string): string {
  return line.length > LOG_LINE_LIMIT ? line.slice(0, LOG_LINE_LIMIT) : line
}

/** What `console.<level>(...args)` prints, as one string: the same `%s` and object rendering Node uses. */
export function formatArgs (args: readonly unknown[]): string {
  try {
    return format(...args)
  } catch {
    return '[unprintable]'
  }
}

/** The lines one console call becomes. The first carries the time and the level; the rest of a multi-line message (a stack) are indented under it, so a line is never longer than the limit and a stack stays readable. */
export function logLines (level: LogLevel, text: string, at: Date): string[] {
  const [first, ...rest] = text.split('\n')
  return [cut(`${at.toISOString()} ${level.toUpperCase()} ${first ?? ''}`), ...rest.map((line) => cut(`${CONTINUATION}${line}`))]
}

export class LogRing {
  private readonly kept: string[] = []

  /** Adds the lines of one call and returns them, for whoever else writes them down. */
  push (level: LogLevel, text: string, at: Date): string[] {
    const lines = logLines(level, text, at)
    this.kept.push(...lines)
    if (this.kept.length > LOG_RING_LINES) this.kept.splice(0, this.kept.length - LOG_RING_LINES)
    return lines
  }

  /** Oldest first. */
  lines (): string[] {
    return [...this.kept]
  }
}

type Sink = (level: LogLevel, text: string) => void

/** Wraps the console's five methods so each still prints, then hands its text to `sink`. A sink that throws is ignored, and a console call the sink itself makes is not recorded again. Returns the way back. */
export function captureConsole (target: Pick<Console, LogLevel>, sink: Sink): () => void {
  const originals = Object.fromEntries(LOG_LEVELS.map((level) => [level, target[level]])) as Record<LogLevel, (...args: unknown[]) => void>
  let inside = false
  for (const level of LOG_LEVELS) {
    target[level] = (...args: unknown[]): void => {
      originals[level].apply(target, args)
      if (inside) return
      inside = true
      try {
        sink(level, formatArgs(args))
      } catch {
        // A failing recorder must never turn a log call into a crash.
      } finally {
        inside = false
      }
    }
  }
  return () => { for (const level of LOG_LEVELS) target[level] = originals[level] }
}
