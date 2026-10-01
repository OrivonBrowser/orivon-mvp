// The history file's shape: the tables, the trigram search index over them, and the steps that bring an older
// file up to date. Pure SQL over a `DatabaseSync` it is handed, so the store and its tests share one definition.
import type { DatabaseSync } from 'node:sqlite'

export const SCHEMA_VERSION = 3

/** The trigram FTS5 index over `pages(title, url)` and the triggers that keep it in step with every insert,
 * update and delete on `pages` -- including a bulk UPDATE/DELETE, since SQLite fires the same row-level
 * triggers for those. `content=` makes it an external-content table: the text is never duplicated, only
 * indexed. One definition, used both by the v1-to-v2 migration and by `rebuildFtsIndex` after a bulk
 * delete has dropped it -- CREATE, not re-CREATE, either way, since both start from it not existing. */
const FTS_INDEX_DDL = `
  CREATE VIRTUAL TABLE pages_fts USING fts5(title, url, content='pages', content_rowid='id', tokenize='trigram');
  INSERT INTO pages_fts(pages_fts, rank) VALUES ('secure-delete', 1);
  CREATE TRIGGER pages_fts_ai AFTER INSERT ON pages BEGIN
    INSERT INTO pages_fts(rowid, title, url) VALUES (new.id, new.title, new.url);
  END;
  CREATE TRIGGER pages_fts_ad AFTER DELETE ON pages BEGIN
    INSERT INTO pages_fts(pages_fts, rowid, title, url) VALUES ('delete', old.id, old.title, old.url);
  END;
  CREATE TRIGGER pages_fts_au AFTER UPDATE ON pages WHEN old.title IS NOT new.title OR old.url IS NOT new.url BEGIN
    INSERT INTO pages_fts(pages_fts, rowid, title, url) VALUES ('delete', old.id, old.title, old.url);
    INSERT INTO pages_fts(rowid, title, url) VALUES (new.id, new.title, new.url);
  END;
`

/** Ends the open transaction, if there is one: the failure being reported may have come before its BEGIN. */
export function rollback (db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK')
  } catch {
    // No transaction was open: the failure was before BEGIN.
  }
}

/** Drops the FTS5 index and the triggers that feed it -- triggers are schema objects of their own, defined
 * `ON pages`, and are not dropped along with the virtual table they reference. Used only inside the store's
 * bulk delete, always paired with `rebuildFtsIndex` in the same transaction: the store is never left with a
 * caller able to observe `pages` without a matching index. */
export function dropFtsIndex (db: DatabaseSync): void {
  db.exec('DROP TRIGGER pages_fts_ai; DROP TRIGGER pages_fts_ad; DROP TRIGGER pages_fts_au; DROP TABLE pages_fts;')
}

/** Recreates the FTS5 index from `FTS_INDEX_DDL` and rebuilds it from every row currently in `pages`. */
export function rebuildFtsIndex (db: DatabaseSync): void {
  db.exec(FTS_INDEX_DDL)
  db.exec("INSERT INTO pages_fts(pages_fts) VALUES ('rebuild')")
}

/** Brings the file to `SCHEMA_VERSION`, one step per version, each leaving its rows intact. Throws for a file
 * from a newer version, which is left exactly as it was. */
export function migrate (db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
  let version = row?.user_version ?? 0
  if (version > SCHEMA_VERSION) throw new Error(`the history file is from a newer version (${String(version)})`)
  if (version < 1) {
    db.exec(`
      CREATE TABLE pages (
        id INTEGER PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL DEFAULT '',
        last_visit INTEGER NOT NULL,
        visit_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE visits (
        id INTEGER PRIMARY KEY,
        page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        at INTEGER NOT NULL
      );
      CREATE INDEX visits_at ON visits (at);
      CREATE INDEX visits_page ON visits (page_id);
      CREATE INDEX pages_last_visit ON pages (last_visit DESC);
      PRAGMA user_version = 1;
    `)
    version = 1
  }
  if (version < 2) {
    // `secure-delete`, part of the index DDL, stays set across every later reopen: without it, FTS5's own delete
    // only tombstones a posting, leaving it in already-allocated pages that `secure_delete`/VACUUM on `pages`
    // itself cannot reach.
    inTransaction(db, () => {
      rebuildFtsIndex(db)
      db.exec('PRAGMA user_version = 2')
    })
    version = 2
  }
  if (version < 3) {
    // `typed_count` is how often an address was typed rather than followed; `favicons` holds one icon per host,
    // apart from `pages` so that a page's row stays small and an icon is shared by every page of its site.
    inTransaction(db, () => {
      db.exec(`
        ALTER TABLE pages ADD COLUMN typed_count INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE favicons (host TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL);
        PRAGMA user_version = 3;
      `)
    })
  }
}

function inTransaction (db: DatabaseSync, body: () => void): void {
  db.exec('BEGIN')
  try {
    body()
    db.exec('COMMIT')
  } catch (error) {
    rollback(db)
    throw error
  }
}
