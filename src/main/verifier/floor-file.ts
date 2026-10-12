// A keyed set of small values kept in the profile between runs, the least
// recently touched dropped past a cap, written to disk after a short debounce
// instead of once per save. By default the values are "highest value seen"
// floors: one decimal per key, never lowered. A caller may give its own rule
// for what a value is and which one wins.

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

/** What a value is, and whether `next` may take the place of `current`. */
export interface ValueRule {
  readonly valid: (value: string) => boolean
  readonly replaces: (current: string, next: string) => boolean
}

const HIGHEST_DECIMAL: ValueRule = {
  valid: (value) => DECIMAL.test(value),
  replaces: (current, next) => BigInt(next) > BigInt(current)
}

export class FloorFile {
  /** Hydrated from disk on first save, then kept in memory between the
   * debounced flushes: this class is the only writer of its own file, so
   * nothing else changes it out from under a pending batch. */
  private floors: Map<string, string> | undefined
  private flushTimer: NodeJS.Timeout | undefined
  /** Every async write waits for the one before it: they share one temporary file. */
  private writing: Promise<void> = Promise.resolve()

  /**
   * @param isKey checked on every key read from disk and every key saved, independently of the process that reported it: this store does not assume its caller already did
   * @param cap kept at once; see each caller for why that many
   * @param what names the floors in the log line of a failed write
   * @param rule which values are kept and which wins; the highest decimal when not given
   */
  constructor (
    private readonly dir: string,
    private readonly path: string,
    private readonly isKey: (key: string) => boolean,
    private readonly cap: number,
    private readonly what: string,
    private readonly rule: ValueRule = HIGHEST_DECIMAL
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

  /** The value kept for `key`, once loaded. */
  get (key: string): string | undefined {
    return this.loaded().get(key)
  }

  /**
   * Keeps the winning value per key, so a restart never forgets how far a
   * name has advanced. Saving the value already kept only moves the key to
   * the newest end, without a write of its own. Returns whether the kept
   * value changed.
   */
  save (key: string, value: string): boolean {
    if (!this.rule.valid(value) || !this.isKey(key)) return false
    const floors = this.loaded()
    const current = floors.get(key)
    if (current === value) {
      floors.delete(key)
      floors.set(key, value)
      return false
    }
    if (current !== undefined && !this.rule.replaces(current, value)) return false
    floors.delete(key) // re-inserted below, now the most recently touched
    floors.set(key, value)
    for (const oldest of floors.keys()) {
      if (floors.size <= this.cap) break
      floors.delete(oldest)
    }
    this.scheduleFlush()
    return true
  }

  /** Forgets every value, in memory and on disk. The write waits for any one already under way, so an older snapshot cannot land after it. */
  async clear (): Promise<void> {
    if (this.flushTimer !== undefined) { clearTimeout(this.flushTimer); this.flushTimer = undefined }
    this.floors = new Map()
    await this.write(this.floors)
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
    return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, string] => this.isKey(entry[0]) && typeof entry[1] === 'string' && this.rule.valid(entry[1])))
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
    const turn = this.writing.catch(() => {}).then(async () => { await this.writeNow(floors) })
    this.writing = turn
    await turn
  }

  private async writeNow (floors: ReadonlyMap<string, string>): Promise<void> {
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
