// <userData>/session.json: the browser's open windows, kept up to date while it runs. It is read once, at
// start, and what it held then stays available as `previous()` however much is written afterwards.
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomicAsync } from '../../broker/adapters/atomic-write.js'
import { DebouncedWriter } from '../storage/debounced-writer.js'
import { parseSession, SESSION_VERSION } from './session-types.js'
import type { SavedSession, SavedWindow } from './session-types.js'

/** What the store writes: asked for at write time, so a burst of changes costs one snapshot. */
/** How long a change of titles alone may wait to be written: a page retitling itself twice a second is not a reason
 * to rewrite the session twice a second, and a crash loses at most this much of the titles a restore shows. */
export const TITLE_WRITE_DELAY_MS = 30_000

export type SessionSource = () => readonly SavedWindow[]

export interface SessionLog {
  load: () => Promise<void>
  /** The session the file held when the browser started, or null: none, unreadable, or a private session. */
  previous: () => SavedSession | null
  attach: (source: SessionSource) => void
  /** Windows of a run that ended in a crash and are still offered back: written beside the open ones until an orderly
   * end, so a second crash before they are restored does not lose them. */
  carry: (windows: SessionSource) => void
  /** The open windows changed: write them soon. */
  changed: () => void
  /** Only titles changed: write them with the next change, or within TITLE_WRITE_DELAY_MS. */
  titlesChanged: () => void
  /** The browser is ending in an orderly way: the next write says so. */
  finish: () => void
  flush: () => Promise<void>
}

export class SessionStore implements SessionLog {
  private found: SavedSession | null = null
  private loading: Promise<void> | null = null
  private source: SessionSource | null = null
  private carried: SessionSource = () => []
  private clean = false
  /** A write is already waiting: changes until it runs need no timer of their own, so a page whose title never stops changing cannot postpone the write for ever. */
  private waiting = false
  private titleTimer: ReturnType<typeof setTimeout> | null = null
  private readonly writer = new DebouncedWriter(async () => { await this.writeNow() })

  constructor (private readonly filePath: string) {}

  load (): Promise<void> {
    this.loading ??= this.readFromDisk()
    return this.loading
  }

  private async readFromDisk (): Promise<void> {
    try {
      this.found = parseSession(await readFile(this.filePath, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[orivon] session file unreadable, starting without it:', error)
    }
  }

  previous (): SavedSession | null {
    return this.found
  }

  attach (source: SessionSource): void {
    this.source = source
  }

  carry (windows: SessionSource): void {
    this.carried = windows
  }

  changed (): void {
    if (this.source === null || this.waiting) return
    this.dropTitleTimer()
    this.waiting = true
    this.writer.schedule()
  }

  titlesChanged (): void {
    if (this.source === null || this.waiting || this.titleTimer !== null) return
    this.titleTimer = setTimeout(() => { this.titleTimer = null; this.changed() }, TITLE_WRITE_DELAY_MS)
    this.titleTimer.unref?.()
  }

  finish (): void {
    this.dropTitleTimer()
    this.clean = true
    this.waiting = false
    this.writer.schedule()
  }

  private dropTitleTimer (): void {
    if (this.titleTimer === null) return
    clearTimeout(this.titleTimer)
    this.titleTimer = null
  }

  async flush (): Promise<void> {
    await this.writer.flush()
  }

  /** Off the main thread: the file and its directory are flushed to disk, which can take a slow disk a while. */
  private async writeNow (): Promise<void> {
    this.waiting = false
    if (this.source === null) return
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const windows = this.clean ? this.source() : [...this.source(), ...this.carried()]
      await writeFileAtomicAsync(this.filePath, JSON.stringify({ version: SESSION_VERSION, clean: this.clean, windows }))
    } catch (error) {
      console.error('[orivon] failed to persist the session:', error)
      throw error
    }
  }
}

/** A private session writes nothing and remembers nothing of an earlier one. */
export class NullSessionStore implements SessionLog {
  async load (): Promise<void> {}
  carry (): void {}
  previous (): SavedSession | null { return null }
  attach (): void {}
  changed (): void {}
  titlesChanged (): void {}
  finish (): void {}
  async flush (): Promise<void> {}
}
