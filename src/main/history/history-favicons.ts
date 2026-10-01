// One icon per site, kept in the `favicons` table beside the pages. An icon is forgotten with the last page of its
// site, so clearing history leaves no list of sites behind.
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { sanitizeStoredFavicon } from '../browsing/bookmarks.js'
import { faviconHost } from './favicon-host.js'
import type { HistoryEntry } from './history-store.js'

/** The most sites that keep an icon; past it the ones refreshed longest ago go. */
export const MAX_FAVICON_HOSTS = 2000
/** The most hosts one listing looks up. */
const MAX_LOOKUP_HOSTS = 500
/** A larger icon is not kept: the file holds one per site (at most about 16 MB of icons in all), a listing sends them to
 * a page, and a site's own tab still shows its full icon. */
export const MAX_HISTORY_FAVICON_CHARS = 8192

interface Statements {
  upsert: StatementSync
  trim: StatementSync
  prune: StatementSync
  lookup: StatementSync
}

const prepared = new WeakMap<DatabaseSync, Statements>()

// A page of a host is any address that starts with the host and ends it at a path or a port: the `url` index
// answers each range, so the cost follows the number of icons, never the number of pages. `0` and `;` are the
// characters after `/` and `:`.
const PAGE_OF_HOST = `
  (url >= 'http://' || f.host || '/' AND url < 'http://' || f.host || '0') OR
  (url >= 'https://' || f.host || '/' AND url < 'https://' || f.host || '0') OR
  (url >= 'ipfs://' || f.host || '/' AND url < 'ipfs://' || f.host || '0') OR
  (url >= 'ipns://' || f.host || '/' AND url < 'ipns://' || f.host || '0') OR
  (url >= 'http://' || f.host || ':' AND url < 'http://' || f.host || ';') OR
  (url >= 'https://' || f.host || ':' AND url < 'https://' || f.host || ';')`

/** Prepares the statements of this module once, so a read never has to. */
export function prepareFaviconStatements (db: DatabaseSync): Statements {
  let found = prepared.get(db)
  if (found === undefined) {
    found = {
      // Every offer refreshes `updated`, so what is trimmed is the icon of the site visited longest ago, not the one
      // changed longest ago: a site seen every day keeps its icon. The store offers a host once per run.
      upsert: db.prepare(`
        INSERT INTO favicons (host, data, updated) VALUES (?, ?, ?)
        ON CONFLICT (host) DO UPDATE SET data = excluded.data, updated = excluded.updated`),
      trim: db.prepare(`
        DELETE FROM favicons WHERE host IN (
          SELECT host FROM favicons ORDER BY updated ASC, host ASC LIMIT MAX(0, (SELECT COUNT(*) FROM favicons) - ?))`),
      // The hosts travel as one JSON array, so the statement is the same whatever their number.
      lookup: db.prepare('SELECT host, data FROM favicons WHERE host IN (SELECT value FROM json_each(?))'),
      prune: db.prepare(`DELETE FROM favicons AS f WHERE NOT EXISTS (SELECT 1 FROM pages WHERE ${PAGE_OF_HOST})`)
    }
    prepared.set(db, found)
  }
  return found
}

/** Keeps `dataUrl` as the icon of `host`, replacing the one it had, and notes that the site was seen now. Anything that is
 * not an image is refused. */
export function setHostFavicon (db: DatabaseSync, host: string, dataUrl: string, now: () => number = Date.now): void {
  if (host === '' || dataUrl.length > MAX_HISTORY_FAVICON_CHARS) return
  const safe = sanitizeStoredFavicon(dataUrl)
  if (safe === null) return
  const { upsert, trim } = prepareFaviconStatements(db)
  upsert.run(host, safe, now())
  trim.run(MAX_FAVICON_HOSTS)
}

/** The icon of each of `hosts` that has one. */
export function faviconsForHosts (db: DatabaseSync, hosts: readonly string[]): Record<string, string> {
  const wanted = [...new Set(hosts)].filter((host) => host !== '').slice(0, MAX_LOOKUP_HOSTS)
  if (wanted.length === 0) return {}
  const rows = prepareFaviconStatements(db).lookup.all(JSON.stringify(wanted)) as Array<{ host: string, data: string }>
  return Object.fromEntries(rows.map((row) => [row.host, row.data]))
}

/** Forgets the icon of every site that no page in the history belongs to. */
export function pruneHostFavicons (db: DatabaseSync): void {
  prepareFaviconStatements(db).prune.run()
}

/** `entries`, each with the icon of its site when there is one. An entry of a site with no icon is left as it is. */
export function withFavicons (db: DatabaseSync, entries: readonly HistoryEntry[]): HistoryEntry[] {
  const icons = faviconsForHosts(db, entries.map((entry) => faviconHost(entry.url) ?? ''))
  return entries.map((entry) => {
    const icon = icons[faviconHost(entry.url) ?? '']
    return icon === undefined ? entry : { ...entry, favicon: icon }
  })
}
