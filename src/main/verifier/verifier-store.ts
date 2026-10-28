// What the verifier keeps in the profile between runs: the salt the IPFS
// node's partition keys are made with, the newest
// checkpoint the light client verified, the highest IPNS sequence seen per
// key, the highest Swarm feed index seen per feed, and the address scheme each
// `.eth` name's content was last found under. A missing or corrupt
// file reads as empty, never as an error.

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CID } from 'multiformats/cid'
import { base36 } from 'multiformats/bases/base36'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { MAX_ADDRESS_NAME } from '../../protocols/address.js'
import { FloorFile } from './floor-file.js'
import { FUTURE_TOLERANCE_SECONDS, parseCheckpoint, parseStoredCheckpoint } from './checkpoint.js'
import type { Checkpoint, StoredCheckpoint } from './checkpoint.js'

export { DECIMAL } from './floor-file.js'

/** Kept at once; the least recently touched dropped first. Any page can
 * make the host resolve any number of `.eth`/IPNS names, so this rollback
 * floor must not grow with however many it asks for. The size is what it
 * costs such a page to push one name's floor out: that many other valid
 * IPNS names, each resolved. About 120 bytes each on disk. */
export const MAX_IPNS_KEYS = 4096
/** Same bound for feeds, and for the same reason: any page can make the host follow any number of Swarm feeds. */
export const MAX_FEEDS = 4096
/** Same bound for `.eth` names, and for the same reason: any page can make the host mount any number of names. A name dropped shows its default scheme until it is next mounted. */
export const MAX_NAME_SCHEMES = 4096

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

/** A feed key: its owner (20 bytes) and topic (32 bytes) in lowercase hex, which is what `swarm/feed.ts` keys a floor by. */
function isFeedKey (key: string): boolean {
  return /^[0-9a-f]{40}\/[0-9a-f]{64}$/.test(key)
}

/** A `.eth` name in the one spelling `ProtocolAddresses` reads a host as, since that is what looks a scheme up. */
function isTopLevelDomainName (key: string): boolean {
  if (key.length > MAX_ADDRESS_NAME) return false
  const served = BUILTIN_ADDRESSES.servedName(key)
  return served !== undefined && served.namespace.startsWith('.') && served.name === key
}

/** A scheme some built-in protocol serves, and a new one replaces the kept one: a name that moves networks is shown by where it is now. */
const SERVED_SCHEME = {
  valid: (value: string): boolean => BUILTIN_ADDRESSES.servesScheme(value),
  replaces: (): boolean => true
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
  private readonly saltPath: string
  private readonly dir: string
  private readonly sequences: FloorFile
  private readonly feeds: FloorFile
  private readonly nameSchemes: FloorFile

  /** The directory in the profile everything this keeps, and the verifier host's Swarm chunk files, are in. */
  get directory (): string {
    return this.dir
  }

  constructor (dir: string) {
    this.checkpointPath = join(dir, 'checkpoint.json')
    this.saltPath = join(dir, 'ipfs-node-partition-salt.json')
    this.dir = dir
    this.sequences = new FloorFile(dir, join(dir, 'ipns-sequences.json'), isIpnsKey, MAX_IPNS_KEYS, 'IPNS sequences')
    this.feeds = new FloorFile(dir, join(dir, 'swarm-feed-indexes.json'), isFeedKey, MAX_FEEDS, 'Swarm feed indexes')
    this.nameSchemes = new FloorFile(dir, join(dir, 'name-schemes.json'), isTopLevelDomainName, MAX_NAME_SCHEMES, 'name schemes', SERVED_SCHEME)
  }

  checkpoint (): StoredCheckpoint | undefined {
    return parseStoredCheckpoint(readJson(this.checkpointPath))
  }

  /**
   * Keeps only a newer one: a host reporting an older checkpoint must not
   * age the install. One dated after `nowSeconds` is refused, since it would
   * block every later save and then age out with nothing to replace it.
   */
  saveCheckpoint (checkpoint: Checkpoint, nowSeconds: number): void {
    this.write(checkpoint, undefined, nowSeconds)
  }

  /**
   * The same, for a checkpoint fetched at run time: kept with the servers that agreed on it, until the light client stores a
   * newer one of its own. A stored checkpoint whose root is in `unserved` (the beacon server has no bootstrap for it) is
   * replaced even by one that is not newer, since it can start nothing.
   */
  saveFetchedCheckpoint (checkpoint: Checkpoint, servers: readonly string[], nowSeconds: number, unserved: ReadonlySet<string> = new Set()): void {
    this.write(checkpoint, servers, nowSeconds, unserved)
  }

  private write (checkpoint: Checkpoint, fetchedFrom: readonly string[] | undefined, nowSeconds: number, unserved: ReadonlySet<string> = new Set()): void {
    if (parseCheckpoint(checkpoint) === undefined || checkpoint.timestamp > nowSeconds + FUTURE_TOLERANCE_SECONDS) return
    const current = this.checkpoint()
    if (current !== undefined && current.timestamp >= checkpoint.timestamp && !unserved.has(current.root)) return
    mkdirSync(this.dir, { recursive: true })
    writeFileAtomic(this.checkpointPath, JSON.stringify(fetchedFrom === undefined ? { root: checkpoint.root, timestamp: checkpoint.timestamp } : { root: checkpoint.root, timestamp: checkpoint.timestamp, fetchedFrom }))
  }

  /** The IPNS floors, from memory once loaded (see `FloorFile.all`). */
  ipnsSequences (): Record<string, string> {
    return this.sequences.all()
  }

  /** Keeps the highest per key, up to `MAX_IPNS_KEYS`; the write to disk is debounced, never one fsync per call. */
  saveIpnsSequence (key: string, sequence: string): void {
    this.sequences.save(key, sequence)
  }

  /** Highest Swarm feed update index seen, keyed `<owner>/<topic>`. */
  swarmFeedIndexes (): Record<string, string> {
    return this.feeds.all()
  }

  saveSwarmFeedIndex (feed: string, index: string): void {
    this.feeds.save(feed, index)
  }

  /** The address scheme the content of a `.eth` name was last found under, from memory once loaded. */
  nameScheme (name: string): string | undefined {
    return this.nameSchemes.get(name)
  }

  /** Whether the name's kept scheme changed, so the shell knows to show it again. The write to disk is debounced. */
  saveNameScheme (name: string, scheme: string): boolean {
    return this.nameSchemes.save(name, scheme)
  }

  /**
   * The random bytes, in hex, that the IPFS node's store keys are made with (`verifier-host/partition-key.ts`): made
   * once per profile and kept here, and handed to the verifier host alone. Replaced by `rotatePartitionSalt`.
   */
  partitionSalt (): string {
    const kept = readJson(this.saltPath)
    if (typeof kept === 'object' && kept !== null && typeof (kept as { salt?: unknown }).salt === 'string' && /^[0-9a-f]{64}$/.test((kept as { salt: string }).salt)) return (kept as { salt: string }).salt
    return this.rotatePartitionSalt()
  }

  /** A new salt, so what the node kept under the old one can no longer be asked for: used when browsing data is cleared. */
  rotatePartitionSalt (): string {
    const salt = randomBytes(32).toString('hex')
    mkdirSync(this.dir, { recursive: true })
    writeFileAtomic(this.saltPath, JSON.stringify({ salt }))
    return salt
  }

  /** Forgets every name's scheme, so each shows its default until it is next mounted. The file is emptied before this resolves. */
  async forgetNameSchemes (): Promise<void> {
    await this.nameSchemes.clear()
  }

  /** Writes whatever is pending right now, instead of waiting out the debounce. Used by tests; `flushSync` is what quit calls, since nothing after `will-quit` can be awaited. */
  async flush (): Promise<void> {
    await this.sequences.flush()
    await this.feeds.flush()
    await this.nameSchemes.flush()
  }

  flushSync (): void {
    this.sequences.flushSync()
    this.feeds.flushSync()
    this.nameSchemes.flushSync()
  }
}
