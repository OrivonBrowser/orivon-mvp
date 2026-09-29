// What the verifier keeps in the profile between runs: the newest
// checkpoint the light client verified, and the highest IPNS sequence seen
// per key. A missing or corrupt file reads as empty, never as an error.

import { mkdirSync, readFileSync } from 'node:fs'
import { mkdir, open, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { CID } from 'multiformats/cid'
import { base36 } from 'multiformats/bases/base36'
import { writeFileAtomic } from '../../broker/grants/node-ledger-storage.js'
import { FUTURE_TOLERANCE_SECONDS, parseCheckpoint } from './checkpoint.js'
import type { Checkpoint } from './checkpoint.js'

/** A decimal, up to 20 digits (past uint64's own ceiling): an IPNS sequence's own shape, shared with the boundary check on messages the host posts (`host-messages.ts`). */
export const DECIMAL = /^\d{1,20}$/

/** Kept at once; the least recently touched dropped first. Any page can
 * make the host resolve any number of `.eth`/IPNS names, so this rollback
 * floor -- a cache, never a ledger -- must not grow with however many it
 * asks for. */
export const MAX_IPNS_KEYS = 512
/** How long a run of saves waits before its one write to disk: an update a
 * page can trigger by the thousand must cost one write for the whole burst,
 * not one fsync each. */
const IPNS_FLUSH_DEBOUNCE_MS = 2_000

/** An IPNS key, spelled the way `resolveIpnsKey` (ipfs/ipns.ts) parses one:
 * a base36 CID whose multihash is an inlined public key (identity) or a
 * hash of one (sha2-256) -- nothing else names an IPNS key, so nothing else
 * is worth a floor entry. Checked again here, independently of the process
 * that reported it: this store does not assume its caller already did. */
function isIpnsKey (key: string): boolean {
  try {
    const code = CID.parse(key, base36).multihash.code
    return code === 0x00 || code === 0x12
  } catch {
    return false
  }
}

function readJson (path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

export class VerifierStore {
  private readonly checkpointPath: string
  private readonly sequencesPath: string
  /** Hydrated from disk on first save, then kept in memory between the
   * debounced flushes below: this store is the only writer of its own
   * file, so nothing else changes it out from under a pending batch. */
  private sequences: Map<string, string> | undefined
  private flushTimer: NodeJS.Timeout | undefined

  constructor (private readonly dir: string) {
    this.checkpointPath = join(dir, 'checkpoint.json')
    this.sequencesPath = join(dir, 'ipns-sequences.json')
  }

  checkpoint (): Checkpoint | undefined {
    return parseCheckpoint(readJson(this.checkpointPath))
  }

  /**
   * Keeps only a newer one: a host reporting an older checkpoint must not
   * age the install. One dated after `nowSeconds` is refused, since it would
   * block every later save and then age out with nothing to replace it.
   */
  saveCheckpoint (checkpoint: Checkpoint, nowSeconds: number): void {
    if (parseCheckpoint(checkpoint) === undefined || checkpoint.timestamp > nowSeconds + FUTURE_TOLERANCE_SECONDS) return
    const current = this.checkpoint()
    if (current !== undefined && current.timestamp >= checkpoint.timestamp) return
    this.write(this.checkpointPath, checkpoint)
  }

  /**
   * Answers from the in-memory floors once loaded, never the file: a host
   * that restarts asks this same store again before its own debounced write
   * has landed, and a rollback protection kept only on disk would then hand
   * the restarted host an older floor than the one it already reported.
   */
  ipnsSequences (): Record<string, string> {
    return Object.fromEntries(this.loadedSequences())
  }

  /**
   * Keeps the highest per key, so a restart never forgets how far a name
   * has advanced, up to `MAX_IPNS_KEYS`; the write to disk is debounced
   * (`scheduleFlush`), never one fsync per call.
   */
  saveIpnsSequence (key: string, sequence: string): void {
    if (!DECIMAL.test(sequence) || !isIpnsKey(key)) return
    const sequences = this.loadedSequences()
    const current = sequences.get(key)
    if (current !== undefined && BigInt(current) >= BigInt(sequence)) return
    sequences.delete(key) // re-inserted below, now the most recently touched
    sequences.set(key, sequence)
    for (const oldest of sequences.keys()) {
      if (sequences.size <= MAX_IPNS_KEYS) break
      sequences.delete(oldest)
    }
    this.scheduleFlush()
  }

  /** Writes whatever is pending right now, instead of waiting out the
   * debounce. Used by tests; `flushSync` below is what quit actually calls,
   * since nothing after `will-quit` can be awaited. */
  async flush (): Promise<void> {
    if (this.flushTimer !== undefined) { clearTimeout(this.flushTimer); this.flushTimer = undefined }
    if (this.sequences === undefined) return
    await this.writeSequences(this.sequences)
  }

  /** The quit-time equivalent of `flush`: blocking, so the process cannot
   * exit out from under an async write the way `will-quit` otherwise would. */
  flushSync (): void {
    if (this.flushTimer !== undefined) { clearTimeout(this.flushTimer); this.flushTimer = undefined }
    if (this.sequences === undefined) return
    this.write(this.sequencesPath, Object.fromEntries(this.sequences))
  }

  private loadedSequences (): Map<string, string> {
    this.sequences ??= new Map(Object.entries(this.readSequencesFromDisk()))
    return this.sequences
  }

  private readSequencesFromDisk (): Record<string, string> {
    const stored = readJson(this.sequencesPath)
    if (typeof stored !== 'object' || stored === null) return {}
    return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, string] => isIpnsKey(entry[0]) && typeof entry[1] === 'string' && DECIMAL.test(entry[1])))
  }

  private scheduleFlush (): void {
    if (this.flushTimer !== undefined) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      const sequences = this.sequences
      if (sequences === undefined) return
      this.writeSequences(sequences).catch((error: unknown) => { console.error('[verifier] failed to save IPNS sequences:', error) })
    }, IPNS_FLUSH_DEBOUNCE_MS)
    this.flushTimer.unref()
  }

  private async writeSequences (sequences: ReadonlyMap<string, string>): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const text = JSON.stringify(Object.fromEntries(sequences))
    const tmp = `${this.sequencesPath}.tmp`
    const handle = await open(tmp, 'w')
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, this.sequencesPath)
  }

  private write (path: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true })
    writeFileAtomic(path, JSON.stringify(value))
  }
}
