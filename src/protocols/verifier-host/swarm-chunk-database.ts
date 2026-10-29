// Verified Swarm chunks kept on disk between runs, one SQLite file per salt. A chunk is stored under the
// partition key of the site that fetched it and is hashed against its address again when it is read back, so the
// disk is trusted no more than the node. The update a site's feed was last followed to is kept the same way, as a
// row of the chunk table under its single-owner address, and handed back unchecked for the caller to verify.
// Everything here is an optimisation: an error is logged once and the chunk is fetched again. README.md's Design
// notes say why the file is shaped as it is.

import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { feedUpdateAddress, MAX_CHUNK_BYTES, MAX_SOC_BYTES, verifyCac } from '../swarm/chunk.js'
import type { FeedId } from '../swarm/feed.js'
import { partitionStoreKey } from './partition-key.js'
import { swarmChunkFile, swarmChunkFileSet, swarmChunkFilesIn } from './swarm-chunk-files.js'
import { attach, OtherSchema } from './swarm-chunk-schema.js'
import type { Statements } from './swarm-chunk-schema.js'

export interface SwarmChunkDatabaseOptions {
  /** The verifier's directory in the profile. */
  readonly dir: string
  /** The profile's partition salt, in hex: it keys the rows and names the file. */
  readonly salt: string
  /** A line for the report log; none names a site or an address. */
  readonly log?: (line: string) => void
  /** Chunk bytes kept at most; the least recently used go first. */
  readonly maxBytes?: number
  /** The clock the logical one below is paced by. */
  readonly now?: () => number
}

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024
/** Eviction stops at this share of the cap, so it is not done again by the next write. */
const KEPT_AFTER_EVICTION = 0.9
const FLUSH_ROWS = 64
const FLUSH_MS = 250
/** The most `used` marks written in one transaction; the rest wait for the next. */
const MAX_TOUCHES = 512
/** The most keys remembered as marked this minute; past it the memory is cleared and a few marks are written twice. */
const MAX_NOTED = 32_768
const EVICT_BATCH = 256
const MINUTE_MS = 60_000
const ADDRESS = /^[0-9a-f]{64}$/
const DECIMAL = /^[0-9]{1,20}$/
/** One past the largest index a feed update's address can name. */
const INDEX_LIMIT = 2n ** 64n
/** SQLite's primary result codes for a file that is not, or is no longer, a sound database (SQLITE_CORRUPT, SQLITE_NOTADB). */
const DAMAGED = [11, 26]

interface Waiting {
  readonly site: string
  readonly address: string
  readonly bytes: Uint8Array
}

interface Found {
  readonly id: number
  /** A blob in every row this writes; SQLite would hold any other value a hand-edited file puts there. */
  readonly bytes: unknown
  readonly size: number
}

/** The index a `feed_update` row holds, or undefined for a value that is not one an address can name (a hand-edited file's). */
function indexOf (position: unknown): bigint | undefined {
  if (typeof position !== 'string' || !DECIMAL.test(position)) return undefined
  const index = BigInt(position)
  return index < INDEX_LIMIT ? index : undefined
}

/** The key a feed is kept under: its owner's 20 bytes, then its topic's 32. */
function feedKey (feed: FeedId): Buffer {
  return Buffer.from(`${feed.owner}${feed.topic}`, 'hex')
}

/** Why an operation failed, without the paths or text an error may carry. */
function reasonOf (error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { errstr, code } = error as { errstr?: unknown, code?: unknown }
    if (typeof errstr === 'string') return errstr
    if (typeof code === 'string') return code
  }
  return 'unknown error'
}

/** Whether `error` says the file is damaged, as against busy, full, unreadable or anything else a retry or a person could mend. */
function isDamage (error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode
  return typeof code === 'number' && DAMAGED.includes(code & 0xff)
}

export class SwarmChunkDatabase {
  /** Chunks answered from the file since this was made. */
  fromDisk = 0
  /** Rows that no longer hashed to their address, and were deleted. */
  refused = 0
  private db: DatabaseSync | undefined
  private statements: Statements | undefined
  private unusable = false
  private complained = false
  private remade = false
  private bytes = 0
  /** Rows are aged by this count of minutes of use, not by the wall clock, which may be wrong or move back. */
  private clock = 0
  private clockWall: number | undefined
  private readonly maxBytes: number
  private readonly now: () => number
  private readonly waiting = new Map<string, Waiting>()
  private readonly touched = new Map<string, Pick<Waiting, 'site' | 'address'>>()
  private readonly noted = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | undefined

  /** Opens no database: the file is made at the first use. It does delete the files of every other salt, which no one opens now. */
  constructor (private readonly options: SwarmChunkDatabaseOptions) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.now = options.now ?? Date.now
    this.removeOthers()
  }

  /** The chunk `address` that `partition`'s pages kept, checked against its address again; undefined when there is none or it fails. */
  get (partition: string, address: string): Uint8Array | undefined {
    if (!ADDRESS.test(address)) return undefined
    const site = partitionStoreKey(this.options.salt, partition)
    const waiting = this.waiting.get(`${site}\n${address}`)
    if (waiting !== undefined) return waiting.bytes
    const statements = this.use()
    if (statements === undefined) return undefined
    let row: Found | undefined
    try {
      row = statements.find.get(site, Buffer.from(address, 'hex')) as Found | undefined
    } catch (error) {
      this.fail('read', error)
      return undefined
    }
    if (row === undefined) return undefined
    if (!(row.bytes instanceof Uint8Array) || !verifyCac(address, row.bytes)) {
      if (!this.isFeedUpdate(statements, row.id)) this.refuse(statements, row)
      return undefined
    }
    this.note(site, address)
    this.fromDisk++
    return row.bytes
  }

  /**
   * The update `partition`'s page last followed `feed` to: its index and its single-owner chunk, as stored and not checked, since
   * checking it is the caller's. Undefined when none is kept, when its chunk has been evicted, or when its row cannot be read.
   */
  getFeedUpdate (partition: string, feed: FeedId): { index: bigint, chunk: Uint8Array } | undefined {
    const statements = this.use()
    if (statements === undefined) return undefined
    const site = partitionStoreKey(this.options.salt, partition)
    const key = feedKey(feed)
    let row: Found | undefined
    let index: bigint | undefined
    try {
      const at = statements.findFeed.get(site, key) as { position: unknown } | undefined
      if (at === undefined) return undefined
      index = indexOf(at.position)
      if (index !== undefined) row = statements.find.get(site, Buffer.from(feedUpdateAddress(feed.owner, feed.topic, index), 'hex')) as Found | undefined
    } catch (error) {
      this.fail('read', error)
      return undefined
    }
    if (index === undefined || row === undefined || !(row.bytes instanceof Uint8Array)) {
      this.dropFeedUpdate(partition, feed)
      return undefined
    }
    this.note(site, feedUpdateAddress(feed.owner, feed.topic, index))
    return { index, chunk: row.bytes }
  }

  /**
   * Keeps `chunk`, the single-owner chunk of update `index` of `feed` that the caller checked, for `partition`, in place of the
   * update kept before and never below it. It counts toward the cap like a chunk, and is written at once: it is rare, and a
   * restart straight after must find it.
   */
  putFeedUpdate (partition: string, feed: FeedId, index: bigint, chunk: Uint8Array): void {
    if (chunk.length > MAX_SOC_BYTES || index < 0n || index >= 2n ** 64n) return
    const statements = this.use()
    if (statements === undefined) return
    const site = partitionStoreKey(this.options.salt, partition)
    const key = feedKey(feed)
    try {
      this.bytes = this.write(() => {
        const before = statements.findFeed.get(site, key) as { position: unknown } | undefined
        const old = indexOf(before?.position)
        if (old !== undefined && old > index) return this.bytes
        let bytes = this.bytes
        if (old !== undefined && old !== index) bytes = this.removeUpdate(statements, site, feed, old, bytes)
        const address = Buffer.from(feedUpdateAddress(feed.owner, feed.topic, index), 'hex')
        const inserted = statements.insert.run(site, address, chunk)
        if (Number(inserted.changes) === 1) {
          statements.insertAge.run(Number(inserted.lastInsertRowid), this.stamp(), chunk.length)
          bytes += chunk.length
        } else {
          statements.touchKey.run(this.stamp(), site, address)
        }
        const stored = statements.find.get(site, address) as Found | undefined
        if (stored !== undefined) statements.setFeed.run(site, key, index.toString(), stored.id)
        return this.evict(statements, bytes)
      })
    } catch (error) {
      this.fail('write', error)
    }
  }

  /** Forgets what is kept for `feed` in `partition`: the update's row and its chunk; with `only`, just while that is the update kept. */
  dropFeedUpdate (partition: string, feed: FeedId, only?: bigint): void {
    const statements = this.use()
    if (statements === undefined) return
    const site = partitionStoreKey(this.options.salt, partition)
    try {
      this.bytes = this.write(() => {
        const at = statements.findFeed.get(site, feedKey(feed)) as { position: unknown } | undefined
        const index = indexOf(at?.position)
        if (only !== undefined && index !== undefined && index !== only) return this.bytes
        const bytes = index === undefined ? this.bytes : this.removeUpdate(statements, site, feed, index, this.bytes)
        statements.removeFeed.run(site, feedKey(feed))
        return bytes
      })
    } catch (error) {
      this.fail('write', error)
    }
  }

  /** Deletes the chunk of update `index` of `feed` from the table, if it is there; returns the bytes kept after. */
  private removeUpdate (statements: Statements, site: string, feed: FeedId, index: bigint, bytes: number): number {
    const row = statements.find.get(site, Buffer.from(feedUpdateAddress(feed.owner, feed.topic, index), 'hex')) as Found | undefined
    if (row === undefined) return bytes
    statements.removeChunk.run(row.id)
    statements.removeAge.run(row.id)
    return Math.max(0, bytes - row.size)
  }

  /** Marks a chunk the memory above answered as used now, so what a person uses all day is not what eviction takes first. */
  touch (partition: string, address: string): void {
    if (this.statements !== undefined && ADDRESS.test(address)) this.note(partitionStoreKey(this.options.salt, partition), address)
  }

  /** Keeps `bytes`, a chunk already checked against `address`, for `partition`. Written with the others of the next 250 ms. */
  put (partition: string, address: string, bytes: Uint8Array): void {
    if (!ADDRESS.test(address) || bytes.length > MAX_CHUNK_BYTES || this.use() === undefined) return
    const site = partitionStoreKey(this.options.salt, partition)
    this.waiting.set(`${site}\n${address}`, { site, address, bytes })
    if (this.waiting.size >= FLUSH_ROWS) this.flush()
    else this.schedule()
  }

  /** Writes what waits, in one transaction. A failure drops it and is logged once. */
  flush (): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const statements = this.statements
    if (statements === undefined) {
      this.waiting.clear()
      this.touched.clear()
      return
    }
    if (this.waiting.size === 0 && this.touched.size === 0) return
    const rows = [...this.waiting.values()]
    this.waiting.clear()
    const touches: Array<Pick<Waiting, 'site' | 'address'>> = []
    for (const [key, touch] of this.touched) {
      if (touches.length >= MAX_TOUCHES) break
      touches.push(touch)
      this.touched.delete(key)
    }
    try {
      this.bytes = this.write(() => {
        const stamp = this.stamp()
        let bytes = this.bytes
        for (const row of rows) {
          const address = Buffer.from(row.address, 'hex')
          const inserted = statements.insert.run(row.site, address, row.bytes)
          if (Number(inserted.changes) === 1) {
            statements.insertAge.run(Number(inserted.lastInsertRowid), stamp, row.bytes.length)
            bytes += row.bytes.length
          } else {
            statements.touchKey.run(stamp, row.site, address)
          }
        }
        for (const touch of touches) statements.touchKey.run(stamp, touch.site, Buffer.from(touch.address, 'hex'))
        return this.evict(statements, bytes)
      })
    } catch (error) {
      this.fail('write', error)
    }
    if (this.touched.size > 0) this.schedule()
  }

  /** Writes what waits and lets go of the file; a later use opens it again. */
  close (): void {
    this.flush()
    this.release()
  }

  /** `work` in one transaction, which is rolled back when it throws. */
  private write<T> (work: () => T): T {
    const db = this.db
    if (db === undefined) throw new Error('the chunk store is not open')
    db.exec('BEGIN IMMEDIATE')
    try {
      const done = work()
      db.exec('COMMIT')
      return done
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* the failure being reported is the first */ }
      throw error
    }
  }

  /** The count rows are aged by: it ticks once in a minute of use, and once at the first mark of a run, so rows of an earlier run are always older. */
  private stamp (): number {
    const now = this.now()
    if (this.clockWall === undefined || now < this.clockWall || now - this.clockWall >= MINUTE_MS) {
      this.clock++
      this.clockWall = now
    }
    return this.clock
  }

  /** Queues the mark of a row as used now, at most once in a minute for the same row. */
  private note (site: string, address: string): void {
    const stamp = this.stamp()
    const key = `${site}\n${address}`
    if (this.noted.get(key) === stamp) return
    if (this.noted.size >= MAX_NOTED) this.noted.clear()
    this.noted.set(key, stamp)
    this.touched.set(key, { site, address })
    this.schedule()
  }

  private schedule (): void {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, FLUSH_MS)
    this.timer.unref()
  }

  /** Whether a feed update is kept in the chunk row `id`: a row of one is a single-owner chunk, which no content address matches. */
  private isFeedUpdate (statements: Statements, id: number): boolean {
    try {
      return statements.isUpdate.get(id) !== undefined
    } catch {
      return false
    }
  }

  /** Deletes the least recently used rows until the file is under its cap with room to spare, and the feed rows whose chunk went with them; returns the bytes left. */
  private evict (statements: Statements, bytes: number): number {
    if (bytes <= this.maxBytes) return bytes
    const left = this.evictOldest(statements, bytes)
    statements.removeOrphanFeeds.run()
    return left
  }

  private evictOldest (statements: Statements, bytes: number): number {
    const target = Math.floor(this.maxBytes * KEPT_AFTER_EVICTION)
    let left = bytes
    while (left > target) {
      const oldest = statements.oldest.all(EVICT_BATCH) as Array<{ id: number, size: number }>
      if (oldest.length === 0) return 0
      for (const { id, size } of oldest) {
        if (left <= target) break
        statements.removeChunk.run(id)
        statements.removeAge.run(id)
        left -= size
      }
    }
    return left
  }

  /** A row that fails its address is deleted at once, so the chunk is fetched and kept again. */
  private refuse (statements: Statements, row: Found): void {
    this.refused++
    if (this.refused === 1) this.options.log?.('swarm: a chunk kept on disk failed its address and was dropped')
    try {
      this.bytes = this.write(() => {
        statements.removeChunk.run(row.id)
        statements.removeAge.run(row.id)
        return Math.max(0, this.bytes - row.size)
      })
    } catch (error) {
      this.fail('write', error)
    }
  }

  /** An error from the open file: damage makes the file again (once), anything else is said once. */
  private fail (what: string, error: unknown): void {
    if (!isDamage(error)) {
      this.complain(what, error)
      return
    }
    this.release()
    this.removeFiles()
    if (this.remade) {
      this.unusable = true
      this.complain(what, error)
      return
    }
    this.remade = true
    this.options.log?.('swarm: the chunk store file was damaged and was made again')
  }

  private complain (what: string, error: unknown): void {
    if (this.complained) return
    this.complained = true
    this.options.log?.(`swarm: the chunk store could not ${what} (${reasonOf(error)}); a site is read from the node again until it can`)
  }

  /** Lets go of the file and of what was waiting to go into it. */
  private release (): void {
    try { this.db?.close() } catch { /* nothing more to keep */ }
    this.db = undefined
    this.statements = undefined
    this.waiting.clear()
    this.touched.clear()
    this.noted.clear()
    this.bytes = 0
  }

  private removeFiles (): void {
    for (const name of swarmChunkFileSet(this.options.salt)) {
      try { rmSync(join(this.options.dir, name), { force: true }) } catch { /* the next open meets the same file and says so */ }
    }
  }

  /** The statements of the open file, opening it first; undefined once opening failed, which is final for this run. */
  private use (): Statements | undefined {
    if (this.statements !== undefined || this.unusable) return this.statements
    try {
      mkdirSync(this.options.dir, { recursive: true })
      this.open()
    } catch (error) {
      this.unusable = true
      this.complain('be opened', error)
    }
    return this.statements
  }

  /** Opens this salt's file; one that is damaged or of another layout is deleted and made again, once in a run, and one that fails any other way is left as it is. */
  private open (): void {
    const path = join(this.options.dir, swarmChunkFile(this.options.salt))
    let opened: ReturnType<typeof attach>
    try {
      opened = attach(path)
    } catch (error) {
      const why = isDamage(error) ? 'was damaged' : error instanceof OtherSchema ? 'was of another layout' : undefined
      if (why === undefined || this.remade) throw error
      this.removeFiles()
      this.remade = true
      opened = attach(path)
      this.options.log?.(`swarm: the chunk store file ${why} and was made again`)
    }
    this.db = opened.db
    this.statements = opened.statements
    this.bytes = opened.bytes
    this.clock = opened.clock
    this.clockWall = undefined
    this.options.log?.(`swarm: the chunk store opened with ${String(this.bytes)} bytes kept`)
  }

  /** The files of every other salt are no one's now: main deletes them when data is cleared, and a file it could not delete goes at the next start of the host. */
  private removeOthers (): void {
    let names: string[]
    try {
      names = readdirSync(this.options.dir)
    } catch {
      return
    }
    for (const name of swarmChunkFilesIn(names, this.options.salt)) {
      try { rmSync(join(this.options.dir, name), { force: true }) } catch { /* a locked file goes at the next start */ }
    }
  }
}
