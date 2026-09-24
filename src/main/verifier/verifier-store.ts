// What the verifier keeps in the profile between runs: the newest
// checkpoint the light client verified, and the highest IPNS sequence seen
// per key. A missing or corrupt file reads as empty, never as an error.

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../../broker/grants/node-ledger-storage.js'
import { FUTURE_TOLERANCE_SECONDS, parseCheckpoint } from './checkpoint.js'
import type { Checkpoint } from './checkpoint.js'

const DECIMAL = /^\d{1,20}$/

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

  ipnsSequences (): Record<string, string> {
    const stored = readJson(this.sequencesPath)
    if (typeof stored !== 'object' || stored === null) return {}
    return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && DECIMAL.test(entry[1])))
  }

  /** Keeps the highest per key, so a restart never forgets how far a name has advanced. */
  saveIpnsSequence (key: string, sequence: string): void {
    if (!DECIMAL.test(sequence)) return
    const all = this.ipnsSequences()
    const current = all[key]
    if (current !== undefined && BigInt(current) >= BigInt(sequence)) return
    all[key] = sequence
    this.write(this.sequencesPath, all)
  }

  private write (path: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true })
    writeFileAtomic(path, JSON.stringify(value))
  }
}
