// The place the last-used window had, in <userData>/window-state.json: numbers and one flag, nothing a page
// chose. A private session uses the null store and never writes a file.
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import { DebouncedWriter } from '../storage/debounced-writer.js'
import { isRect } from './placement.js'
import type { SavedPlacement } from './placement.js'

const FILE_VERSION = 1
const WRITE_DELAY_MS = 500

export interface WindowStateStore {
  /** Reads the file once. A missing, corrupt or out-of-range file leaves nothing saved. */
  load: () => Promise<void>
  get: () => SavedPlacement | null
  set: (placement: SavedPlacement) => void
  flush: () => Promise<void>
}

/** The saved place out of a parsed file, or null when it is not one this version wrote. */
export function parseSaved (parsed: unknown): SavedPlacement | null {
  if (typeof parsed !== 'object' || parsed === null) return null
  const { version, bounds, maximized } = parsed as Record<string, unknown>
  if (version !== FILE_VERSION || !isRect(bounds) || typeof maximized !== 'boolean') return null
  return { bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, maximized }
}

export class FileWindowStateStore implements WindowStateStore {
  private saved: SavedPlacement | null = null
  private loading: Promise<void> | null = null
  private readonly writer = new DebouncedWriter(async () => { this.writeNow() }, WRITE_DELAY_MS)

  constructor (private readonly filePath: string) {}

  load (): Promise<void> {
    this.loading ??= this.readFromDisk()
    return this.loading
  }

  private async readFromDisk (): Promise<void> {
    try {
      this.saved = parseSaved(JSON.parse(await readFile(this.filePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[orivon] window state unreadable, opening where a window opens by default:', error)
    }
  }

  get (): SavedPlacement | null {
    return this.saved
  }

  set (placement: SavedPlacement): void {
    const next = parseSaved({ version: FILE_VERSION, ...placement })
    if (next === null) return
    const current = this.saved
    if (current !== null && current.maximized === next.maximized && JSON.stringify(current.bounds) === JSON.stringify(next.bounds)) return
    this.saved = next
    this.writer.schedule()
  }

  async flush (): Promise<void> {
    await this.writer.flush()
  }

  private writeNow (): void {
    if (this.saved === null) return
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileAtomic(this.filePath, JSON.stringify({ version: FILE_VERSION, ...this.saved }, null, 2))
    } catch (error) {
      console.error('[orivon] failed to persist the window state:', error)
      throw error
    }
  }
}

/** Remembers nothing and writes nothing. */
export class NullWindowStateStore implements WindowStateStore {
  async load (): Promise<void> {}
  get (): SavedPlacement | null { return null }
  set (): void {}
  async flush (): Promise<void> {}
}
