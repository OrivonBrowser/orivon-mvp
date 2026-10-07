// `logs/current.log`: what the ring holds, kept on disk too so a crash that takes the process leaves it behind.
// Lines are buffered and written within 250 ms, or at once when the process is about to exit. The file stops
// growing at 2 MiB with one line saying so; a start renames it to `previous.log`.
import { appendFileSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export const LOG_FLUSH_MS = 250
export const LOG_FILE_LIMIT = 2 * 1024 * 1024
export const TRUNCATED_LINE = '--- log truncated: the file reached its size limit ---'

export class LogFile {
  private buffer: string[] = []
  private written = 0
  private full = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly path: string

  /** Makes the directory and moves the last run's file aside. A disk that refuses leaves a log that is simply not written. */
  constructor (dir: string) {
    this.path = join(dir, 'current.log')
    try {
      mkdirSync(dir, { recursive: true })
      try { renameSync(this.path, join(dir, 'previous.log')) } catch { /* the first start has nothing to move */ }
    } catch {
      this.full = true
    }
  }

  append (lines: readonly string[]): void {
    if (this.full) return
    this.buffer.push(...lines)
    this.timer ??= setTimeout(() => { this.flush() }, LOG_FLUSH_MS)
    this.timer.unref()
  }

  /** Writes what is buffered now. Called by the timer, and directly when the process is exiting. */
  flush (): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (this.buffer.length === 0 || this.full) { this.buffer = []; return }
    let text = `${this.buffer.join('\n')}\n`
    this.buffer = []
    const room = LOG_FILE_LIMIT - this.written
    if (Buffer.byteLength(text) > room) {
      text = `${Buffer.from(text).subarray(0, Math.max(0, room)).toString('utf8')}\n${TRUNCATED_LINE}\n`
      this.full = true
    }
    try {
      appendFileSync(this.path, text)
      this.written += Buffer.byteLength(text)
    } catch {
      this.full = true
    }
  }
}

/** The last `count` lines of a log file, oldest first; none when it cannot be read. */
export function readLogTail (path: string, count: number): string[] {
  try {
    const lines = readFileSync(path, 'utf8').split('\n')
    if (lines.at(-1) === '') lines.pop()
    return lines.slice(-count)
  } catch {
    return []
  }
}
