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
import { swarmChunkFile, swarmChunkFileSet, swarmChunkFilesIn } from './swarm-chunk-files.js'

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
/** A 4 KB chunk row is a little over 4 KB: a smaller page would give each row two, and 32 KB holds seven. */
const PAGE_BYTES = 32768
const CACHE_KIB = 8192
const MINUTE_MS = 60_000
const ADDRESS = /^[0-9a-f]{64}$/
/** SQLite's primary result codes for a file that is not, or is no longer, a sound database (SQLITE_CORRUPT, SQLITE_NOTADB). */
const DAMAGED = [11, 26]

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chunk (
  id INTEGER PRIMARY KEY,
  site TEXT NOT NULL,
  address BLOB NOT NULL,
  bytes BLOB NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS chunk_key ON chunk (site, address);
CREATE TABLE IF NOT EXISTS age (id INTEGER PRIMARY KEY, used INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS age_used ON age (used);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
`

interface Statements {
  readonly find: StatementSync
  readonly insert: StatementSync
  readonly insertAge: StatementSync
  readonly touchKey: StatementSync
  readonly removeChunk: StatementSync
  readonly removeAge: StatementSync
  readonly oldest: StatementSync
  readonly setMeta: StatementSync
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

function attach (path: string): { db: DatabaseSync, statements: Statements, bytes: number, clock: number } {
  const db = new DatabaseSync(path)
  try {
    db.exec(`PRAGMA page_size = ${String(PAGE_BYTES)}`)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec(`PRAGMA cache_size = -${String(CACHE_KIB)}`)
    db.exec(SCHEMA)
    const statements: Statements = {
      find: db.prepare('SELECT id, bytes, length(bytes) AS size FROM chunk WHERE site = ? AND address = ?'),
      insert: db.prepare('INSERT OR IGNORE INTO chunk (site, address, bytes) VALUES (?, ?, ?)'),
      insertAge: db.prepare('INSERT OR REPLACE INTO age (id, used) VALUES (?, ?)'),
      touchKey: db.prepare('UPDATE age SET used = ? WHERE id = (SELECT id FROM chunk WHERE site = ? AND address = ?)'),
      removeChunk: db.prepare('DELETE FROM chunk WHERE id = ?'),
      removeAge: db.prepare('DELETE FROM age WHERE id = ?'),
      oldest: db.prepare('SELECT age.id AS id, length(chunk.bytes) AS size FROM age JOIN chunk ON chunk.id = age.id ORDER BY age.used, age.id LIMIT ?'),
      setMeta: db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    }
    const meta = new Map((db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string, value: number }>).map((row) => [row.key, row.value]))
    const bytes = meta.get('bytes') ?? (db.prepare('SELECT coalesce(sum(length(bytes)), 0) AS total FROM chunk').get() as { total: number }).total
    return { db, statements, bytes, clock: meta.get('clock') ?? 0 }
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

  /** Opens nothing: the file is made at the first use. */
  constructor (private readonly options: SwarmChunkDatabaseOptions) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.now = options.now ?? Date.now
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
      this.refuse(statements, row)
      return undefined
    }
    this.note(site, address)
    this.fromDisk++
    return row.bytes
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
            statements.insertAge.run(Number(inserted.lastInsertRowid), stamp)
            bytes += row.bytes.length
          } else {
            statements.touchKey.run(stamp, row.site, address)
          }
        }
        for (const touch of touches) statements.touchKey.run(stamp, touch.site, Buffer.from(touch.address, 'hex'))
        bytes = this.evict(statements, bytes)
        statements.setMeta.run('bytes', bytes)
        statements.setMeta.run('clock', this.clock)
        return bytes
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
        const left = Math.max(0, this.bytes - row.size)
        statements.setMeta.run('bytes', left)
        return left
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
      this.removeOthers()
      this.open()
    } catch (error) {
      this.unusable = true
      this.complain('be opened', error)
    }
    return this.statements
  }

  /** Opens this salt's file; one that is damaged is deleted and made again once, and one that fails any other way is left as it is. */
  private open (): void {
    const path = join(this.options.dir, swarmChunkFile(this.options.salt))
    let opened: ReturnType<typeof attach>
    try {
      opened = attach(path)
    } catch (error) {
      if (!isDamage(error)) throw error
      this.removeFiles()
      this.remade = true
      opened = attach(path)
      this.options.log?.('swarm: the chunk store file was damaged and was made again')
    }
    this.db = opened.db
    this.statements = opened.statements
    this.bytes = opened.bytes
    this.clock = opened.clock
    this.clockWall = undefined
    this.options.log?.(`swarm: the chunk store opened with ${String(this.bytes)} bytes kept`)
  }

  /** The files of every other salt are no one's now: main deletes them when data is cleared, and a file it could not delete goes here. */
  private removeOthers (): void {
    for (const name of swarmChunkFilesIn(readdirSync(this.options.dir), this.options.salt)) {
      try { rmSync(join(this.options.dir, name), { force: true }) } catch { /* a locked file goes at the next start */ }
    }
  }
}
