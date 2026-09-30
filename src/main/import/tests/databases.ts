// Small real databases in the shape of other browsers' files, built with node:sqlite, for the readers' tests.
import { DatabaseSync } from 'node:sqlite'

export const WEBKIT_OFFSET_MS = 11_644_473_600_000

/** Chromium's time: microseconds since 1601. Above 2^53, so it goes in as a BigInt. */
export const webkitMicros = (unixMs: number): bigint => (BigInt(unixMs) + BigInt(WEBKIT_OFFSET_MS)) * 1000n

export interface ChromeRow { url: string, title: string, visits: number, at: number }

/** A History file in WAL mode. The returned handle keeps the log unfolded, as a running browser does; close it when done. */
export function makeChromeHistory (path: string, rows: readonly ChromeRow[], { wal = true } = {}): DatabaseSync {
  const db = new DatabaseSync(path)
  if (wal) db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0')
  db.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER DEFAULT 0 NOT NULL, typed_count INTEGER DEFAULT 0 NOT NULL, last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0 NOT NULL)')
  const insert = db.prepare('INSERT INTO urls (url, title, visit_count, last_visit_time) VALUES (?, ?, ?, ?)')
  for (const row of rows) insert.run(row.url, row.title, row.visits, webkitMicros(row.at))
  return db
}

export interface PlaceRow { url: string, title: string, visits: number, at: number | null }

export interface FirefoxBookmark { id: number, type: 1 | 2, parent: number, position: number, title: string, guid: string, url?: string, addedMs?: number }

export function makeFirefoxPlaces (path: string, places: readonly PlaceRow[], bookmarks: readonly FirefoxBookmark[] = []): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0')
  db.exec('CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER DEFAULT 0, last_visit_date INTEGER)')
  db.exec('CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER DEFAULT NULL, parent INTEGER, position INTEGER, title LONGVARCHAR, dateAdded INTEGER, guid TEXT)')
  const insertPlace = db.prepare('INSERT INTO moz_places (url, title, visit_count, last_visit_date) VALUES (?, ?, ?, ?)')
  for (const place of places) insertPlace.run(place.url, place.title, place.visits, place.at === null ? null : place.at * 1000)
  const findPlace = db.prepare('SELECT id FROM moz_places WHERE url = ?')
  const insertBookmark = db.prepare('INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, dateAdded, guid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  for (const item of bookmarks) {
    let fk: number | null = null
    if (item.url !== undefined) {
      const found = findPlace.get(item.url) as { id: number } | undefined
      fk = found?.id ?? Number(insertPlace.run(item.url, item.title, 0, null).lastInsertRowid)
    }
    insertBookmark.run(item.id, item.type, fk, item.parent, item.position, item.title, (item.addedMs ?? 0) * 1000, item.guid)
  }
  return db
}
