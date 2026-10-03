// History in one SQLite file. A page is a row, and each time it was reached is
// a row of its own, so a range of time can be forgotten without losing the
// pages visited outside it. Writes wait a moment and go in one transaction, so
// a page that redirects three times is one write, not three. Every statement
// this runs more than once is prepared once, in the constructor or on first
// use, and reused -- never re-prepared per call. The file's shape and its
// migrations are `history-schema.ts` and the listing is `history-list.ts`;
// what the address bar, the History page and the importer add is a file each.
import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import { DebouncedWriter } from '../storage/debounced-writer.js'
import { MAX_TITLE_LENGTH, MAX_URL_LENGTH } from './history-store.js'
import type { HistoryEntry, HistoryImportRow, HistoryQuery, HistoryStore, HistorySuggestion } from './history-store.js'
import { dropFtsIndex, migrate, rebuildFtsIndex, rollback } from './history-schema.js'
import { MAX_FAVICON_HOSTS, MAX_HISTORY_FAVICON_CHARS, faviconsForHosts, prepareFaviconStatements, pruneHostFavicons, trimFavicons, withFavicons, writeHostFavicon } from './history-favicons.js'
import { deletePagesByIds, MAX_IDS, pagesByIds, prepareIdStatements } from './history-ids.js'
import { importHistoryRows } from './history-import.js'
import { FTS_DENSITY_LIMIT, listPages, prepareListStatements } from './history-list.js'
import type { ListStatements } from './history-list.js'
import { listPagesOrdered, prepareOrderStatements } from './history-order.js'
import { markPageTyped, suggestPages } from './history-suggest.js'

const WRITE_DELAY_MS = 500
/** An icon the store already wrote is offered to the file again only after this long, so the time that decides which
 * sites keep their icon stays fresh for a site in use. */
const FAVICON_REFRESH_MS = 60 * 60_000
/** The most changes held while waiting to write; past it the oldest is written at once. */
const MAX_QUEUED = 500
/** The most pages kept. A page can make as many addresses as it likes, and the file must not grow with them: past this the
 * pages least recently visited go, down to nine tenths of it so the trimming is not done on every write. */
const MAX_PAGES = 100_000
/** How many new pages are written between looks at whether there are too many. */
const TRIM_CHECK_EVERY = 1000
/** Above this many rows to delete per row left afterward, dropping the FTS5 index for the delete and
 * rebuilding it once from what remains beats deleting through the per-row secure-delete trigger: measured
 * at roughly 0.33ms/row deleted that way against roughly 0.019ms per row a rebuild has to index, a ~17:1
 * cost ratio the delete side crosses well before 16:1. */
const BULK_DELETE_ROW_RATIO = 16

/** How long an address typed before its page is recorded waits for the page: a slow load is still the page that was typed. */
const TYPED_WAIT_MS = 60_000
const MAX_TYPED_WAITING = 64

type Change =
  | { readonly type: 'visit', readonly url: string, readonly title: string, readonly at: number }
  | { readonly type: 'title', readonly url: string, readonly title: string }
  | { readonly type: 'typed', readonly url: string, readonly at: number }
  | { readonly type: 'favicon', readonly host: string, readonly data: string, readonly at: number }

export class SqliteHistoryStore implements HistoryStore {
  readonly kind = 'sqlite'
  private readonly db: DatabaseSync
  private closed = false
  private newPagesSinceCheck = 0
  private readonly queue: Change[] = []
  /** Addresses typed whose page was not in the history yet, with when they were typed: counted when it is. */
  private readonly typedWaiting = new Map<string, number>()
  /** The icon last offered for each host and when, so the same icon offered again is not written again. */
  private readonly offeredIcons = new Map<string, { readonly data: string, readonly at: number }>()
  private readonly writer = new DebouncedWriter(async () => { this.drain() }, WRITE_DELAY_MS)
  private readonly statements: {
    findPage: StatementSync
    insertPage: StatementSync
    touchPage: StatementSync
    insertVisit: StatementSync
    setTitle: StatementSync
    count: StatementSync
    trimDelete: StatementSync
    remove: StatementSync
    removeRangeDeleteVisits: StatementSync
    removeRangeUpdatePages: StatementSync
    removeRangeDeleteEmptyPages: StatementSync
    /** How many pages would end up with no visits left in [from, to] -- what `removeRange` checks against
     * how many would remain, to choose the bulk or per-row delete path. */
    removeRangeCountToDelete: StatementSync
    list: ListStatements
  }

  private readonly limits: {
    readonly maxPages: number
    readonly checkEvery: number
    readonly searchDensityLimit: number
    readonly bulkDeleteRowRatio: number
  }

  /** `path` may be `:memory:`. Throws if the file is not a database this can use. `limits` is for tests: any
   * field left out keeps its production default. */
  constructor (path: string, limits: {
    readonly maxPages?: number
    readonly checkEvery?: number
    readonly searchDensityLimit?: number
    readonly bulkDeleteRowRatio?: number
  } = {}) {
    this.limits = {
      maxPages: limits.maxPages ?? MAX_PAGES,
      checkEvery: limits.checkEvery ?? TRIM_CHECK_EVERY,
      searchDensityLimit: limits.searchDensityLimit ?? FTS_DENSITY_LIMIT,
      bulkDeleteRowRatio: limits.bulkDeleteRowRatio ?? BULK_DELETE_ROW_RATIO
    }
    this.db = new DatabaseSync(path)
    try {
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec('PRAGMA foreign_keys = ON')
      // Forgotten addresses are overwritten, not only unlisted: what a person clears should not sit readable in the file.
      this.db.exec('PRAGMA secure_delete = ON')
      migrate(this.db)
      prepareFaviconStatements(this.db)
      prepareOrderStatements(this.db)
      prepareIdStatements(this.db)
      this.statements = {
        findPage: this.db.prepare('SELECT id FROM pages WHERE url = ?'),
        insertPage: this.db.prepare('INSERT INTO pages (url, title, last_visit, visit_count) VALUES (?, ?, ?, 1)'),
        touchPage: this.db.prepare('UPDATE pages SET last_visit = MAX(last_visit, ?), visit_count = visit_count + 1 WHERE id = ?'),
        insertVisit: this.db.prepare('INSERT INTO visits (page_id, at) VALUES (?, ?)'),
        setTitle: this.db.prepare('UPDATE pages SET title = ? WHERE url = ? AND title <> ?'),
        count: this.db.prepare('SELECT COUNT(*) AS n FROM pages'),
        trimDelete: this.db.prepare('DELETE FROM pages WHERE id IN (SELECT id FROM pages ORDER BY last_visit ASC, id ASC LIMIT ?)'),
        remove: this.db.prepare('DELETE FROM pages WHERE id = ?'),
        removeRangeDeleteVisits: this.db.prepare('DELETE FROM visits WHERE at >= ? AND at <= ?'),
        // Run before the visits go, on the pages with a visit in [from, to] only: a page's count loses the visits
        // removed and nothing else. An imported page carries its whole count on one visit row, so a recount of its
        // rows would take every visit the other browser counted away.
        removeRangeUpdatePages: this.db.prepare(`
          UPDATE pages SET
            visit_count = MAX(0, visit_count - (SELECT COUNT(*) FROM visits WHERE page_id = pages.id AND at >= ? AND at <= ?)),
            last_visit = COALESCE((SELECT MAX(at) FROM visits WHERE page_id = pages.id AND (at < ? OR at > ?)), 0)
          WHERE id IN (SELECT DISTINCT page_id FROM visits WHERE at >= ? AND at <= ?)
        `),
        removeRangeDeleteEmptyPages: this.db.prepare('DELETE FROM pages WHERE last_visit = 0 AND NOT EXISTS (SELECT 1 FROM visits WHERE page_id = pages.id)'),
        // A page ends up with none of its visits left once [from, to] is removed exactly when it has a
        // visit inside that range and none outside it. Starting from the pages with a visit in range (the
        // visits_at index makes that narrow, however many pages exist in total) rather than scanning every
        // page is what makes this cheap for a range that only ever touches a small slice of a full history.
        removeRangeCountToDelete: this.db.prepare(`
          SELECT COUNT(*) AS n FROM (SELECT DISTINCT page_id FROM visits WHERE at >= ? AND at <= ?) AS v
          WHERE NOT EXISTS (SELECT 1 FROM visits v2 WHERE v2.page_id = v.page_id AND (v2.at < ? OR v2.at > ?))
        `),
        list: prepareListStatements(this.db, this.limits.searchDensityLimit)
      }
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  /** Deletes rows through `mutate`, inside one transaction, choosing between two paths that leave the same
   * result: per-row, where `mutate`'s DELETE/UPDATE fires the FTS5 triggers already in place (secure-delete,
   * ~0.33ms per row deleted); or, when `toDelete` is large enough against `remaining` (`BULK_DELETE_ROW_RATIO`),
   * bulk -- drop the index for `mutate`, so it runs at plain SQLite speed, then rebuild the index once from
   * what is left (~0.019ms per remaining row). `PRAGMA secure_delete = ON` zeroes DROP TABLE's freed pages
   * exactly as it does a per-row DELETE's, so both paths leave nothing of a forgotten row recoverable. */
  private deleteRows (toDelete: number, remaining: number, mutate: () => void): void {
    const bulk = toDelete * this.limits.bulkDeleteRowRatio > remaining
    this.db.exec('BEGIN')
    try {
      if (bulk) dropFtsIndex(this.db)
      mutate()
      if (bulk) rebuildFtsIndex(this.db)
      this.db.exec('COMMIT')
    } catch (error) {
      rollback(this.db)
      throw error
    }
  }

  record (url: string, title: string, at: number): void {
    if (url.length > MAX_URL_LENGTH) return
    this.enqueue({ type: 'visit', url, title: title.slice(0, MAX_TITLE_LENGTH), at })
  }

  setTitle (url: string, title: string): void {
    if (url.length > MAX_URL_LENGTH) return
    this.enqueue({ type: 'title', url, title: title.slice(0, MAX_TITLE_LENGTH) })
  }

  private enqueue (change: Change): void {
    this.queue.push(change)
    if (this.queue.length >= MAX_QUEUED) this.drain()
    else this.writer.schedule()
  }

  /** Writes every waiting change in one transaction. It is called from event handlers and from every read, so a failure
   * (a full disk, a damaged page) is reported and the changes it held are dropped: history is not worth ending the browser for. */
  private drain (): void {
    if (this.closed || this.queue.length === 0) return
    const changes = this.queue.splice(0)
    const { findPage, insertPage, touchPage, insertVisit, setTitle } = this.statements
    let iconsWritten = false
    try {
      this.db.exec('BEGIN')
      for (const change of changes) {
        if (change.type === 'title') {
          setTitle.run(change.title, change.url, change.title)
          continue
        }
        if (change.type === 'favicon') {
          writeHostFavicon(this.db, change.host, change.data, () => change.at)
          iconsWritten = true
          continue
        }
        if (change.type === 'typed') {
          if (!markPageTyped(this.db, change.url)) this.waitForPage(change.url, change.at)
          continue
        }
        const found = findPage.get(change.url) as { id: number } | undefined
        let id: number
        if (found === undefined) {
          id = Number(insertPage.run(change.url, change.title, change.at).lastInsertRowid)
          this.newPagesSinceCheck += 1
        } else {
          id = found.id
          touchPage.run(change.at, id)
          if (change.title !== '') setTitle.run(change.title, change.url, change.title)
        }
        insertVisit.run(id, change.at)
        this.countWaitingTyped(change.url, change.at)
      }
      if (iconsWritten) trimFavicons(this.db)
      this.db.exec('COMMIT')
      if (this.newPagesSinceCheck >= this.limits.checkEvery) this.trim()
    } catch (error) {
      rollback(this.db)
      this.offeredIcons.clear()
      console.error('[orivon] history could not be written:', error)
    }
  }

  /** Forgets the pages least recently visited when there are more than are kept. Always the per-row path,
   * with FTS5 secure-delete switched off for just this delete and back on before the transaction commits
   * (which a ROLLBACK also restores, since the config change is part of the same transaction): trim() runs
   * automatically on the navigation path whenever the history is full, not because a person asked to forget
   * anything, so it is not worth the bulk path's index-drop-and-rebuild cost every few thousand new pages,
   * nor secure-delete's per-row cost. A trimmed page's index entries are removed the next time FTS5 merges
   * its segments on its own, not at delete time -- every forgetting a person actually asks for (remove,
   * removeRange, clear, and the retention prune, itself a removeRange) still erases them at once. */
  private trim (): void {
    this.newPagesSinceCheck = 0
    const total = (this.statements.count.get() as { n: number }).n
    if (total <= this.limits.maxPages) return
    const toDelete = total - Math.floor(this.limits.maxPages * 0.9)
    this.db.exec('BEGIN')
    try {
      this.db.exec("INSERT INTO pages_fts(pages_fts, rank) VALUES ('secure-delete', 0)")
      this.statements.trimDelete.run(toDelete)
      this.db.exec("INSERT INTO pages_fts(pages_fts, rank) VALUES ('secure-delete', 1)")
      this.db.exec('COMMIT')
    } catch (error) {
      rollback(this.db)
      throw error
    }
  }

  list (query: HistoryQuery = {}): HistoryEntry[] {
    this.drain()
    return withFavicons(this.db, listPages(this.statements.list, this.limits.searchDensityLimit, query))
  }

  suggest (text: string, limit: number): HistorySuggestion[] {
    this.drain()
    return suggestPages(this.db, text, limit)
  }

  markTyped (url: string): void {
    if (url.length > MAX_URL_LENGTH) return
    // Queued behind the visit it belongs to, which is recorded once the page has loaded and so may come after.
    this.enqueue({ type: 'typed', url, at: Date.now() })
  }

  private waitForPage (url: string, at: number): void {
    if (this.typedWaiting.size >= MAX_TYPED_WAITING) this.typedWaiting.delete(this.typedWaiting.keys().next().value as string)
    this.typedWaiting.set(url, at)
  }

  private countWaitingTyped (url: string, visitedAt: number): void {
    const typedAt = this.typedWaiting.get(url)
    if (typedAt === undefined) return
    this.typedWaiting.delete(url)
    if (visitedAt - typedAt <= TYPED_WAIT_MS) markPageTyped(this.db, url)
  }

  /** Queued with the visits, so an icon is one more row in their transaction and never a write of its own. */
  setFavicon (host: string, dataUrl: string): void {
    if (host === '' || dataUrl.length > MAX_HISTORY_FAVICON_CHARS) return
    const at = Date.now()
    const offered = this.offeredIcons.get(host)
    if (offered !== undefined && offered.data === dataUrl && at - offered.at < FAVICON_REFRESH_MS) return
    this.offeredIcons.delete(host)
    if (this.offeredIcons.size >= MAX_FAVICON_HOSTS) this.offeredIcons.delete(this.offeredIcons.keys().next().value as string)
    this.offeredIcons.set(host, { data: dataUrl, at })
    this.enqueue({ type: 'favicon', host, data: dataUrl, at })
  }

  faviconsFor (hosts: readonly string[]): Record<string, string> {
    this.drain()
    return faviconsForHosts(this.db, hosts)
  }

  pruneFavicons (): void { this.pruneIcons() }

  listOrdered (query: HistoryQuery = {}): HistoryEntry[] {
    this.drain()
    return listPagesOrdered(this.db, query)
  }

  pagesByIds (ids: readonly number[]): HistoryEntry[] {
    this.drain()
    return pagesByIds(this.db, ids)
  }

  importPages (rows: readonly HistoryImportRow[]): number {
    this.drain()
    const kept = (this.statements.count.get() as { n: number }).n
    return importHistoryRows(this.db, rows, Math.max(this.limits.maxPages - kept, 0))
  }

  count (): number {
    this.drain()
    return (this.statements.count.get() as { n: number }).n
  }

  remove (id: number): void {
    this.drain()
    const total = (this.statements.count.get() as { n: number }).n
    this.deleteRows(1, Math.max(total - 1, 0), () => {
      this.statements.remove.run(id)
      this.pruneIcons()
    })
    this.dropLog()
  }

  removeMany (ids: readonly number[]): void {
    this.drain()
    const wanted = Math.min(ids.length, MAX_IDS)
    const total = (this.statements.count.get() as { n: number }).n
    this.deleteRows(wanted, Math.max(total - wanted, 0), () => {
      deletePagesByIds(this.db, ids)
      this.pruneIcons()
    })
    this.dropLog()
  }

  removeRange (from: number, to: number): void {
    this.drain()
    const toDelete = (this.statements.removeRangeCountToDelete.get(from, to, from, to) as { n: number }).n
    const total = (this.statements.count.get() as { n: number }).n
    this.deleteRows(toDelete, total - toDelete, () => {
      this.statements.removeRangeUpdatePages.run(from, to, from, to, from, to)
      this.statements.removeRangeDeleteVisits.run(from, to)
      this.statements.removeRangeDeleteEmptyPages.run()
      this.pruneIcons()
    })
    this.dropLog()
  }

  clear (): void {
    this.queue.length = 0
    this.typedWaiting.clear()
    const total = (this.statements.count.get() as { n: number }).n
    // Always the bulk path (remaining is 0), unless there was nothing to delete in the first place.
    this.deleteRows(total, 0, () => {
      this.db.exec('DELETE FROM visits; DELETE FROM pages;')
      this.pruneIcons()
    })
    this.dropLog()
    // Rewrites the file so the space the addresses were in is not left behind.
    this.db.exec('VACUUM')
  }

  /** Forgets the icons of sites with no page left. An icon deleted here must be written again when its site returns, so
   * what was offered is forgotten too. */
  private pruneIcons (): void {
    pruneHostFavicons(this.db)
    this.offeredIcons.clear()
  }

  /** Moves what the write-ahead log still holds of forgotten rows into the file, where they were overwritten, and empties the log. */
  private dropLog (): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }

  flush (): void {
    this.drain()
  }

  close (): void {
    if (this.closed) return
    try {
      this.drain()
    } finally {
      this.closed = true
      this.db.close()
    }
  }
}
