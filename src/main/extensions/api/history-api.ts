// chrome.history and chrome.topSites over the shell's history service. A registered app's pages are the
// app's own data: they are in no answer and no event, and an extension can neither add nor delete one.
// When "Remember history" is off, `addUrl` does nothing (the service refuses a visit) and resolves.
import { sanitizeDirectUrl } from '../../browsing/omnibox.js'
import type { HistoryEntry } from '../../history/history-store.js'
import type { ShellServices } from '../../shell/shell-services.js'
import type { ExtensionApiContext, ExtensionApiModule } from './api-types.js'
import { diffHistory, searchWindow, timeOf, toHistoryItem, toVisitItem, WATCH_WINDOW } from './history-shape.js'
import type { HistoryItem } from './history-shape.js'

export type HistoryLike = Pick<ShellServices['history'], 'list' | 'listOrdered' | 'visit' | 'remove' | 'removeMany' | 'removeRange' | 'clear' | 'onChange'>

const BAD_URL = 'Invalid URL.'
const PAGE = 500
/** Most pages a range delete or a search reads: bounds the work of one call on a very large history. */
const MAX_SCAN_PAGES = 100
const TOP_SITES = 10
const TOP_SITES_READ = 30

function fail (message: string): never { throw new Error(message) }

function historyOf (ctx: ExtensionApiContext): HistoryLike {
  return ctx.shell()?.history ?? fail('History is not available yet.')
}

const isWeb = (url: string): boolean => /^https?:\/\//i.test(url)

/** The address an extension named, as the history keeps it; a refusal is Chrome's own message. */
function addressArg (ctx: ExtensionApiContext, details: unknown): string {
  const url = details !== null && typeof details === 'object' ? (details as { url?: unknown }).url : undefined
  if (typeof url !== 'string') return fail('Invalid argument: url must be a string.')
  const safe = sanitizeDirectUrl(url)
  if (safe === null || !isWeb(safe) || ctx.isAppOrigin(safe)) return fail(BAD_URL)
  return safe
}

/** Pages visited in [from, to), newest first, in pages of 500 (every page, a registered app's too). */
function* pagesIn (history: HistoryLike, text: string, from: number, to: number): Generator<HistoryEntry> {
  let after = { lastVisit: to, id: 0 }
  for (let page = 0; page < MAX_SCAN_PAGES; page++) {
    const batch = history.list({ search: text, limit: PAGE, after })
    for (const entry of batch) {
      if (entry.lastVisit < from) return
      yield entry
    }
    const last = batch.at(-1)
    if (last === undefined || batch.length < PAGE) return
    after = { lastVisit: last.lastVisit, id: last.id }
  }
}

function* scan (ctx: ExtensionApiContext, history: HistoryLike, text: string, from: number, to: number): Generator<HistoryEntry> {
  for (const entry of pagesIn(history, text, from, to)) if (!ctx.isAppOrigin(entry.url)) yield entry
}

function findByUrl (ctx: ExtensionApiContext, history: HistoryLike, url: string): HistoryEntry | undefined {
  const batch = history.list({ search: url, limit: PAGE })
  return batch.find((entry) => entry.url === url && !ctx.isAppOrigin(entry.url))
}

function search (ctx: ExtensionApiContext, history: HistoryLike, query: unknown, now: number): HistoryItem[] {
  const window = searchWindow(query, now)
  const out: HistoryItem[] = []
  for (const entry of scan(ctx, history, window.text, window.from, window.to)) {
    out.push(toHistoryItem(entry))
    if (out.length >= window.limit) break
  }
  return out
}

/** Forgets the visits in [from, to). A registered app's pages in the range stay: then the others go by name. */
function forget (ctx: ExtensionApiContext, history: HistoryLike, from: number, to: number, everything: boolean): void {
  const named: number[] = []
  let apps = false
  for (const entry of pagesIn(history, '', from, to)) {
    if (ctx.isAppOrigin(entry.url)) apps = true
    else named.push(entry.id)
  }
  if (apps) history.removeMany(named)
  else if (everything) history.clear()
  else history.removeRange(from, to)
}

function deleteRange (ctx: ExtensionApiContext, history: HistoryLike, range: unknown): void {
  if (range === null || typeof range !== 'object') fail('Invalid argument: the range must be an object.')
  const given = range as { startTime?: unknown, endTime?: unknown }
  forget(ctx, history, timeOf(given.startTime, 'startTime'), timeOf(given.endTime, 'endTime'), false)
}

/** Keeps the newest pages and turns each change of the history into the events Chrome sends. */
function watch (ctx: ExtensionApiContext, history: HistoryLike): void {
  const newest = (): HistoryEntry[] => history.list({ limit: WATCH_WINDOW }).filter((entry) => !ctx.isAppOrigin(entry.url))
  let known = new Map(newest().map((entry) => [entry.id, entry]))
  history.onChange((change) => {
    // A title arriving later is not a visit, and a stored title is read when asked for.
    if (change === 'titled') return
    const fresh = newest()
    const before = known
    known = new Map(fresh.map((entry) => [entry.id, entry]))
    try {
      for (const event of diffHistory(before, fresh)) {
        if (event.type === 'visited') ctx.sendEvent(undefined, 'history.onVisited', event.item)
        else ctx.sendEvent(undefined, 'history.onVisitRemoved', { allHistory: event.allHistory, urls: event.urls })
      }
    } catch (error) {
      console.error('[orivon] a history event could not be sent:', error)
    }
  })
}

export function installHistory (ctx: ExtensionApiContext, now: () => number = Date.now): void {
  ctx.handle('history.search', (_event, query) => search(ctx, historyOf(ctx), query, now()))
  ctx.handle('history.getVisits', (_event, details) => {
    const history = historyOf(ctx)
    const url = details !== null && typeof details === 'object' ? (details as { url?: unknown }).url : undefined
    if (typeof url !== 'string') return fail('Invalid argument: url must be a string.')
    const safe = sanitizeDirectUrl(url) ?? url
    const found = findByUrl(ctx, history, safe)
    return found === undefined ? [] : [toVisitItem(found)]
  })
  ctx.handle('history.addUrl', (_event, details) => {
    const url = addressArg(ctx, details)
    const title = (details as { title?: unknown }).title
    historyOf(ctx).visit(url, typeof title === 'string' ? title.slice(0, 512) : '')
  })
  ctx.handle('history.deleteUrl', (_event, details) => {
    const history = historyOf(ctx)
    const found = findByUrl(ctx, history, addressArg(ctx, details))
    if (found !== undefined) history.remove(found.id)
  })
  ctx.handle('history.deleteRange', (_event, range) => { deleteRange(ctx, historyOf(ctx), range) })
  ctx.handle('history.deleteAll', () => { forget(ctx, historyOf(ctx), 0, Number.MAX_SAFE_INTEGER, true) })
  ctx.onShell((shell) => { watch(ctx, shell.history) })
}

export const historyApi: ExtensionApiModule = {
  name: 'history',
  permission: 'history',
  install: (ctx) => { installHistory(ctx) }
}

/** The most visited web addresses, one per site. The library answers with an empty list; this answers over its handler. */
export function topSites (ctx: ExtensionApiContext): Array<{ url: string, title: string }> {
  const out: Array<{ url: string, title: string }> = []
  const hosts = new Set<string>()
  for (const entry of historyOf(ctx).listOrdered({ order: 'visits', limit: TOP_SITES_READ })) {
    if (!isWeb(entry.url) || ctx.isAppOrigin(entry.url)) continue
    let host: string
    try { host = new URL(entry.url).host } catch { continue }
    if (hosts.has(host)) continue
    hosts.add(host)
    out.push({ url: entry.url, title: entry.title })
    if (out.length >= TOP_SITES) break
  }
  return out
}

export const topSitesApi: ExtensionApiModule = {
  name: 'topSites',
  permission: 'topSites',
  install: (ctx) => { ctx.handle('topSites.get', () => topSites(ctx)) }
}
