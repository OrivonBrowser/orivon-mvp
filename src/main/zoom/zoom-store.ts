// The zoom level a person chose for each site, in <userData>/zoom.json. Keyed by
// origin, so it is the same for a website, a `.eth` name and an app, and
// stored only when it differs from the default: a site at the default holds
// no entry, and follows the default if that changes.
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { originFromUrl } from '../../broker/policy/origin.js'
import { writeFileAtomic } from '../../broker/grants/node-ledger-storage.js'
import { DebouncedWriter } from '../storage/debounced-writer.js'
import { isZoomPercent } from './zoom-steps.js'

const FILE_VERSION = 1
/** The most sites remembered; past it the oldest choice is forgotten. Bounds the file against a browser used for years. */
export const MAX_SITES = 2000

export type ZoomListener = (origin: string | null) => void

export class ZoomStore {
  private readonly levels = new Map<string, number>()
  private loading: Promise<void> | null = null
  private readonly listeners = new Set<ZoomListener>()
  private readonly writer = new DebouncedWriter(async () => { this.writeNow() })

  constructor (private readonly filePath: string) {}

  /** Reads the file once. An entry whose key is not an origin, or whose level is not a whole percent in range, is dropped. */
  load (): Promise<void> {
    this.loading ??= this.readFromDisk()
    return this.loading
  }

  private async readFromDisk (): Promise<void> {
    let stored: unknown
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null && (parsed as { version?: unknown }).version === FILE_VERSION) stored = (parsed as { levels?: unknown }).levels
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[orivon] zoom file unreadable, using the defaults:', error)
      return
    }
    if (typeof stored !== 'object' || stored === null) return
    for (const [origin, percent] of Object.entries(stored)) {
      if (originFromUrl(origin) === origin && isZoomPercent(percent)) this.levels.set(origin, percent)
    }
    this.trim()
  }

  get (origin: string): number | undefined {
    return this.levels.get(origin)
  }

  get size (): number {
    return this.levels.size
  }

  /** Remembers `percent` for `origin`. */
  set (origin: string, percent: number): void {
    if (!isZoomPercent(percent) || originFromUrl(origin) !== origin) return
    // Re-inserted, so the map's order is the order of last choice.
    this.levels.delete(origin)
    this.levels.set(origin, percent)
    this.trim()
    this.changed(origin)
  }

  /** Forgets the choice for `origin`: it follows the default again. */
  remove (origin: string): void {
    if (this.levels.delete(origin)) this.changed(origin)
  }

  /** Forgets every choice. */
  clear (): void {
    if (this.levels.size === 0) return
    this.levels.clear()
    this.changed(null)
  }

  /** `origin` is the site that changed, or null when many did. Returns the removal. */
  onChange (listener: ZoomListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async flush (): Promise<void> {
    await this.writer.flush()
  }

  private trim (): void {
    for (const origin of this.levels.keys()) {
      if (this.levels.size <= MAX_SITES) break
      this.levels.delete(origin)
    }
  }

  private changed (origin: string | null): void {
    this.writer.schedule()
    for (const listener of [...this.listeners]) listener(origin)
  }

  private writeNow (): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileAtomic(this.filePath, JSON.stringify({ version: FILE_VERSION, levels: Object.fromEntries(this.levels) }, null, 2))
    } catch (error) {
      console.error('[orivon] failed to persist zoom levels:', error)
      throw error
    }
  }
}
