// A set of "highest value seen" floors kept in the profile between runs: one
// decimal per key, never lowered, the least recently touched dropped past a
// cap, written to disk after a short debounce instead of once per save.

import { readFileSync, mkdirSync } from 'node:fs'
import { mkdir, open, rename } from 'node:fs/promises'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'

/** A decimal, up to 20 digits (past uint64's own ceiling): an IPNS sequence's own shape, shared with the boundary check on messages the host posts (`host-messages.ts`). */
export const DECIMAL = /^\d{1,20}$/

/** How long a run of saves waits before its one write to disk: an update a
 * page can trigger by the thousand must cost one write for the whole burst,
 * not one fsync each. */
const FLUSH_DEBOUNCE_MS = 2_000

function readJson (path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

export class FloorFile {
  /** Hydrated from disk on first save, then kept in memory between the
   * debounced flushes: this class is the only writer of its own file, so
   * nothing else changes it out from under a pending batch. */
  private floors: Map<string, string> | undefined
  private flushTimer: NodeJS.Timeout | undefined

  /**
   * @param isKey checked on every key read from disk and every key saved, independently of the process that reported it: this store does not assume its caller already did
   * @param cap kept at once; see each caller for why that many
   * @param what names the floors in the log line of a failed write
   */
  constructor (
    private readonly dir: string,
    private readonly path: string,
    private readonly isKey: (key: string) => boolean,
    private readonly cap: number,
    private readonly what: string
  ) {}

  /**
   * Answers from the in-memory floors once loaded, never the file: a host
   * that restarts asks this same store again before its own debounced write
   * has landed, and a rollback protection kept only on disk would then hand
   * the restarted host an older floor than the one it already reported.
   */
  all (): Record<string, string> {
    return Object.fromEntries(this.loaded())
  }

  /** Keeps the highest per key, so a restart never forgets how far a name has advanced. */
  save (key: string, value: string): void {
    if (!DECIMAL.test(value) || !this.isKey(key)) return
    const floors = this.loaded()
    const current = floors.get(key)
    if (current !== undefined && BigInt(current) >= BigInt(value)) return
    floors.delete(key) // re-inserted below, now the most recently touched
    floors.set(key, value)
    for (const oldest of floors.keys()) {
      if (floors.size <= this.cap) break
      floors.delete(oldest)
    }
    this.scheduleFlush()
  }

  /** Writes whatever is pending right now, instead of waiting out the debounce. */
  async flush (): Promise<void> {
    if (this.flushTimer !== undefined) { clearTimeout(this.flushTimer); this.flushTimer = undefined }
    if (this.floors === undefined) return
    await this.write(this.floors)
  }

  /** The quit-time equivalent of `flush`: blocking, so the process cannot exit out from under an async write. */
  flushSync (): void {
    if (this.flushTimer !== undefined) { clearTimeout(this.flushTimer); this.flushTimer = undefined }
    if (this.floors === undefined) return
    mkdirSync(this.dir, { recursive: true })
    writeFileAtomic(this.path, JSON.stringify(Object.fromEntries(this.floors)))
  }

  private loaded (): Map<string, string> {
    this.floors ??= new Map(Object.entries(this.fromDisk()))
    return this.floors
  }

  private fromDisk (): Record<string, string> {
    const stored = readJson(this.path)
    if (typeof stored !== 'object' || stored === null) return {}
    return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, string] => this.isKey(entry[0]) && typeof entry[1] === 'string' && DECIMAL.test(entry[1])))
  }

  private scheduleFlush (): void {
    if (this.flushTimer !== undefined) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      const floors = this.floors
      if (floors === undefined) return
      this.write(floors).catch((error: unknown) => { console.error(`[verifier] failed to save ${this.what}:`, error) })
    }, FLUSH_DEBOUNCE_MS)
    this.flushTimer.unref()
  }

  private async write (floors: ReadonlyMap<string, string>): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const text = JSON.stringify(Object.fromEntries(floors))
    const tmp = `${this.path}.tmp`
    const handle = await open(tmp, 'w')
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, this.path)
  }
}
