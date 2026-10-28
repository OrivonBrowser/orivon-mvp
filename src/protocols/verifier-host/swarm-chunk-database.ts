// Verified Swarm chunks kept on disk between runs, one SQLite file per salt. A chunk is stored under the
// partition key of the site that fetched it and is hashed against its address again when it is read back, so the
// disk is trusted no more than the node. Everything here is an optimisation: an error is logged once and the
// chunk is fetched again. README.md's Design notes say why the file is shaped as it is.

import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import { MAX_CHUNK_BYTES, verifyCac } from '../swarm/chunk.js'
import { partitionStoreKey } from './partition-key.js'
import { swarmChunkFile, swarmChunkFilesIn } from './swarm-chunk-files.js'

export interface SwarmChunkDatabaseOptions {
  /** The verifier's directory in the profile. */
  readonly dir: string
  /** The profile's partition salt, in hex: it keys the rows and names the file. */
  readonly salt: string
  /** A line for the report log; none names a site or an address. */
  readonly log?: (line: string) => void
  /** Chunk bytes kept at most; the least recently used go first. */
  readonly maxBytes?: number
  /** The clock `used` is read from. */
  readonly now?: () => number
}

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024
/** Eviction stops at this share of the cap, so it is not done again by the next write. */
const KEPT_AFTER_EVICTION = 0.9
const FLUSH_ROWS = 64
const FLUSH_MS = 250
/** The most `used` marks written in one transaction; the rest wait for the next. */
const MAX_TOUCHES = 512
const EVICT_BATCH = 256
/** A 4 KB chunk row is a little over 4 KB: a smaller page would give each row two, and 32 KB holds seven. */
const PAGE_BYTES = 32768
const CACHE_KIB = 8192
const MINUTE_MS = 60_000
const ADDRESS = /^[0-9a-f]{64}$/

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chunk (
  id INTEGER PRIMARY KEY,
  site TEXT NOT NULL,
  address BLOB NOT NULL,
  bytes BLOB NOT NULL,
  used INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS chunk_key ON chunk (site, address);
CREATE INDEX IF NOT EXISTS chunk_used ON chunk (used);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
`

interface Statements {
  readonly find: StatementSync
  readonly insert: StatementSync
  readonly touchKey: StatementSync
  readonly touch: StatementSync
  readonly remove: StatementSync
  readonly oldest: StatementSync
  readonly setBytes: StatementSync
}

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
  readonly used: number
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

function attach (path: string): { db: DatabaseSync, statements: Statements, bytes: number } {
  const db = new DatabaseSync(path)
  try {
    db.exec(`PRAGMA page_size = ${String(PAGE_BYTES)}`)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec(`PRAGMA cache_size = -${String(CACHE_KIB)}`)
    db.exec(SCHEMA)
    const statements: Statements = {
      find: db.prepare('SELECT id, bytes, length(bytes) AS size, used FROM chunk WHERE site = ? AND address = ?'),
      insert: db.prepare('INSERT OR IGNORE INTO chunk (site, address, bytes, used) VALUES (?, ?, ?, ?)'),
      touchKey: db.prepare('UPDATE chunk SET used = ? WHERE site = ? AND address = ?'),
      touch: db.prepare('UPDATE chunk SET used = ? WHERE id = ?'),
      remove: db.prepare('DELETE FROM chunk WHERE id = ?'),
      oldest: db.prepare('SELECT id, length(bytes) AS size FROM chunk ORDER BY used, id LIMIT ?'),
      setBytes: db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('bytes', ?)")
    }
    const kept = db.prepare("SELECT value FROM meta WHERE key = 'bytes'").get() as { value: number } | undefined
    if (kept !== undefined) return { db, statements, bytes: kept.value }
    const counted = db.prepare('SELECT coalesce(sum(length(bytes)), 0) AS total FROM chunk').get() as { total: number }
    statements.setBytes.run(counted.total)
    return { db, statements, bytes: counted.total }
  } catch (error) {
    db.close()
    throw error
  }
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
  private bytes = 0
  private readonly maxBytes: number
  private readonly now: () => number
  private readonly waiting = new Map<string, Waiting>()
  private readonly touched = new Set<number>()
  private timer: ReturnType<typeof setTimeout> | undefined

  /** Opens nothing: the file is made at the first use. */
  constructor (private readonly options: SwarmChunkDatabaseOptions) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.now = options.now ?? Date.now
  }

  /** The chunk bytes the file holds. */
  get keptBytes (): number {
    this.use()
    return this.bytes
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
      this.complain('read', error)
      return undefined
    }
    if (row === undefined) return undefined
    if (!(row.bytes instanceof Uint8Array) || !verifyCac(address, row.bytes)) {
      this.refuse(statements, row)
      return undefined
    }
    if (row.used !== this.minute()) {
      this.touched.add(row.id)
      this.schedule()
    }
    this.fromDisk++
    return row.bytes
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
    const { db, statements } = this
    if (db === undefined || statements === undefined) {
      this.waiting.clear()
      this.touched.clear()
      return
    }
    if (this.waiting.size === 0 && this.touched.size === 0) return
    const rows = [...this.waiting.values()]
    this.waiting.clear()
    const touches = [...this.touched].slice(0, MAX_TOUCHES)
    for (const id of touches) this.touched.delete(id)
    try {
      db.exec('BEGIN IMMEDIATE')
      try {
        const minute = this.minute()
        let bytes = this.bytes
        for (const row of rows) {
          const address = Buffer.from(row.address, 'hex')
          if (Number(statements.insert.run(row.site, address, row.bytes, minute).changes) === 1) bytes += row.bytes.length
          else statements.touchKey.run(minute, row.site, address)
        }
        for (const id of touches) statements.touch.run(minute, id)
        bytes = this.evict(statements, bytes)
        statements.setBytes.run(bytes)
        db.exec('COMMIT')
        this.bytes = bytes
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* the failure being reported is the first */ }
        throw error
      }
    } catch (error) {
      this.complain('write', error)
    }
    if (this.touched.size > 0) this.schedule()
  }

  /** Writes what waits and lets go of the file; a later use opens it again. */
  close (): void {
    this.flush()
    try { this.db?.close() } catch { /* nothing more to keep */ }
    this.db = undefined
    this.statements = undefined
  }

  private minute (): number {
    return Math.floor(this.now() / MINUTE_MS)
  }

  private schedule (): void {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, FLUSH_MS)
    this.timer.unref()
  }

  /** Deletes the least recently used rows until the file is under its cap with room to spare; returns the bytes left. */
  private evict (statements: Statements, bytes: number): number {
    if (bytes <= this.maxBytes) return bytes
    const target = Math.floor(this.maxBytes * KEPT_AFTER_EVICTION)
    let left = bytes
    while (left > target) {
      const oldest = statements.oldest.all(EVICT_BATCH) as Array<{ id: number, size: number }>
      if (oldest.length === 0) return 0
      for (const { id, size } of oldest) {
        if (left <= target) break
        statements.remove.run(id)
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
      statements.remove.run(row.id)
      this.bytes = Math.max(0, this.bytes - row.size)
      statements.setBytes.run(this.bytes)
    } catch (error) {
      this.complain('write', error)
    }
  }

  private complain (what: string, error: unknown): void {
    if (this.complained) return
    this.complained = true
    this.options.log?.(`swarm: the chunk store could not ${what} (${reasonOf(error)}); a site is read from the node again until it can`)
  }

  /** The statements of the open file, opening it first; undefined once opening failed, which is final for this run. */
  private use (): Statements | undefined {
    if (this.statements !== undefined || this.unusable) return this.statements
    try {
      mkdirSync(this.options.dir, { recursive: true })
      this.removeOthers()
      this.open()
    } catch (error) {
      this.unusable = true
      this.complain('be opened', error)
    }
    return this.statements
  }

  /** Opens this salt's file; one that is not a database is deleted and made again once. */
  private open (): void {
    const path = join(this.options.dir, swarmChunkFile(this.options.salt))
    let opened: ReturnType<typeof attach>
    try {
      opened = attach(path)
    } catch {
      for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${path}${suffix}`, { force: true })
      opened = attach(path)
      this.options.log?.('swarm: the chunk store file was damaged and was made again')
    }
    this.db = opened.db
    this.statements = opened.statements
    this.bytes = opened.bytes
    this.options.log?.(`swarm: the chunk store opened with ${String(this.bytes)} bytes kept`)
  }

  /** The files of every other salt are no one's now: main deletes them when data is cleared, and a file it could not delete goes here. */
  private removeOthers (): void {
    for (const name of swarmChunkFilesIn(readdirSync(this.options.dir), this.options.salt)) {
      try { rmSync(join(this.options.dir, name), { force: true }) } catch { /* a locked file goes at the next start */ }
    }
  }
}
