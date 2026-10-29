// The layout of the Swarm chunk file and how it is opened: the tables, the layout number, the statements the database
// runs, and the pragmas that give it its pages and its journal. A file of any other layout number is not this code's.

import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import type { FeedId } from '../swarm/feed.js'

/** A 4 KB chunk row is a little over 4 KB: a smaller page would give each row two, and 32 KB holds seven. */
const PAGE_BYTES = 32768
const CACHE_KIB = 8192
/** After a checkpoint the `-wal` is cut back to this size, instead of staying as large as it once grew. */
const WAL_LIMIT_BYTES = 8 * 1024 * 1024
/** The layout `SCHEMA` makes, kept in the file's own `user_version`: a file of any other number is not this code's. */
const SCHEMA_VERSION = 2

const SCHEMA = `
CREATE TABLE chunk (
  id INTEGER PRIMARY KEY,
  site TEXT NOT NULL,
  address BLOB NOT NULL,
  bytes BLOB NOT NULL
);
CREATE UNIQUE INDEX chunk_key ON chunk (site, address);
CREATE TABLE age (id INTEGER PRIMARY KEY, used INTEGER NOT NULL, size INTEGER NOT NULL);
CREATE INDEX age_used ON age (used, size);
CREATE TABLE feed_update (
  site TEXT NOT NULL,
  feed BLOB NOT NULL,
  position TEXT NOT NULL,
  chunk INTEGER NOT NULL,
  PRIMARY KEY (site, feed)
) WITHOUT ROWID;
PRAGMA user_version = ${String(SCHEMA_VERSION)};
`

const DECIMAL = /^[0-9]{1,20}$/
/** One past the largest index a feed update's address can name. */
const INDEX_LIMIT = 2n ** 64n

/** The index a `feed_update` row holds, or undefined for a value that is not one an address can name (a hand-edited file's). */
export function indexOf (position: unknown): bigint | undefined {
  if (typeof position !== 'string' || !DECIMAL.test(position)) return undefined
  const index = BigInt(position)
  return index < INDEX_LIMIT ? index : undefined
}

/** The key a feed is kept under: its owner's 20 bytes, then its topic's 32. */
export function feedKey (feed: FeedId): Buffer {
  return Buffer.from(`${feed.owner}${feed.topic}`, 'hex')
}

export interface Statements {
  readonly find: StatementSync
  readonly insert: StatementSync
  readonly insertAge: StatementSync
  readonly touchKey: StatementSync
  readonly removeChunk: StatementSync
  readonly removeAge: StatementSync
  readonly oldest: StatementSync
  readonly findFeed: StatementSync
  readonly setFeed: StatementSync
  readonly removeFeed: StatementSync
  /** Whether a feed update points at the chunk row. */
  readonly isUpdate: StatementSync
  /** Deletes the feed rows whose chunk is gone. */
  readonly removeOrphanFeeds: StatementSync
}

/** A file that holds some other layout than `SCHEMA`: not damaged, but not this code's to use. */
export class OtherSchema extends Error {}

/** Makes the tables in a new file, and sets the layout number in the same transaction, so a file has both or neither. */
function create (db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(SCHEMA)
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* the failure being reported is the first */ }
    throw error
  }
}

/**
 * What the file holds, counted from the rows of `age` (one for each chunk, with its size): neither number is trusted from
 * an earlier run, whatever stopped it. Counting the chunks themselves would read the whole file (40 to 120 ms for 256 MB
 * on the host's event loop, more on a slow disk); this reads a few dozen pages (2.5 ms).
 */
function counters (db: DatabaseSync): { bytes: number, clock: number } {
  const { total } = db.prepare('SELECT coalesce(sum(size), 0) AS total FROM age').get() as { total: number }
  const { newest } = db.prepare('SELECT coalesce(max(used), 0) AS newest FROM age').get() as { newest: number }
  return { bytes: Number(total), clock: Number(newest) }
}

export function attach (path: string): { db: DatabaseSync, statements: Statements, bytes: number, clock: number } {
  const db = new DatabaseSync(path)
  try {
    db.exec(`PRAGMA page_size = ${String(PAGE_BYTES)}`)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = OFF')
    db.exec(`PRAGMA journal_size_limit = ${String(WAL_LIMIT_BYTES)}`)
    db.exec(`PRAGMA cache_size = -${String(CACHE_KIB)}`)
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
    const { tables } = db.prepare('SELECT count(*) AS tables FROM sqlite_master').get() as { tables: number }
    if (version === 0 && Number(tables) === 0) create(db)
    else if (version !== SCHEMA_VERSION) throw new OtherSchema()
    const statements: Statements = {
      find: db.prepare('SELECT id, bytes, length(bytes) AS size FROM chunk WHERE site = ? AND address = ?'),
      insert: db.prepare('INSERT OR IGNORE INTO chunk (site, address, bytes) VALUES (?, ?, ?)'),
      insertAge: db.prepare('INSERT OR REPLACE INTO age (id, used, size) VALUES (?, ?, ?)'),
      touchKey: db.prepare('UPDATE age SET used = ? WHERE id = (SELECT id FROM chunk WHERE site = ? AND address = ?)'),
      removeChunk: db.prepare('DELETE FROM chunk WHERE id = ?'),
      removeAge: db.prepare('DELETE FROM age WHERE id = ?'),
      oldest: db.prepare('SELECT id, size FROM age ORDER BY used, id LIMIT ?'),
      findFeed: db.prepare('SELECT position FROM feed_update WHERE site = ? AND feed = ?'),
      setFeed: db.prepare('INSERT OR REPLACE INTO feed_update (site, feed, position, chunk) VALUES (?, ?, ?, ?)'),
      removeFeed: db.prepare('DELETE FROM feed_update WHERE site = ? AND feed = ?'),
      isUpdate: db.prepare('SELECT 1 AS yes FROM feed_update WHERE chunk = ?'),
      removeOrphanFeeds: db.prepare('DELETE FROM feed_update WHERE NOT EXISTS (SELECT 1 FROM chunk WHERE chunk.id = feed_update.chunk)')
    }
    return { db, statements, ...counters(db) }
  } catch (error) {
    db.close()
    throw error
  }
}
