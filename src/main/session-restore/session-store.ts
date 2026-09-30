// <userData>/session.json: the browser's open windows, kept up to date while it runs. It is read once, at
// start, and what it held then stays available as `previous()` however much is written afterwards.
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import { DebouncedWriter } from '../storage/debounced-writer.js'
import { parseSession, SESSION_VERSION } from './session-types.js'
import type { SavedSession, SavedWindow } from './session-types.js'

/** What the store writes: asked for at write time, so a burst of changes costs one snapshot. */
export type SessionSource = () => readonly SavedWindow[]

export interface SessionLog {
  load: () => Promise<void>
  /** The session the file held when the browser started, or null: none, unreadable, or a private session. */
  previous: () => SavedSession | null
  attach: (source: SessionSource) => void
  /** The open windows changed: write them soon. */
  changed: () => void
  /** The browser is ending in an orderly way: the next write says so. */
  finish: () => void
  flush: () => Promise<void>
}

export class SessionStore implements SessionLog {
  private found: SavedSession | null = null
  private loading: Promise<void> | null = null
  private source: SessionSource | null = null
  private clean = false
  /** A write is already waiting: changes until it runs need no timer of their own, so a page whose title never stops changing cannot postpone the write for ever. */
  private waiting = false
  private readonly writer = new DebouncedWriter(async () => { this.writeNow() })

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

  changed (): void {
    if (this.source === null || this.waiting) return
    this.waiting = true
    this.writer.schedule()
  }

  finish (): void {
    this.clean = true
    this.waiting = false
    this.writer.schedule()
  }

  async flush (): Promise<void> {
    await this.writer.flush()
  }

  private writeNow (): void {
    this.waiting = false
    if (this.source === null) return
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileAtomic(this.filePath, JSON.stringify({ version: SESSION_VERSION, clean: this.clean, windows: this.source() }))
    } catch (error) {
      console.error('[orivon] failed to persist the session:', error)
      throw error
    }
  }
}

/** A private session writes nothing and remembers nothing of an earlier one. */
export class NullSessionStore implements SessionLog {
  async load (): Promise<void> {}
  previous (): SavedSession | null { return null }
  attach (): void {}
  changed (): void {}
  finish (): void {}
  async flush (): Promise<void> {}
}
