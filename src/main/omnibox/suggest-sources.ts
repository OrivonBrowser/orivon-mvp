// Where the address bar's rows come from: the bookmarks, the history and the tabs open now, each read and scored
// here so `rank` (./suggest.ts) only has to merge. A source is given what it needs through `SuggestContext`, so
// none of it touches Electron. `LATE_SOURCES` is the only place a source that waits (on the network) may go.
import type { Bookmark } from '../browsing/bookmarks.js'
import type { HistorySuggestion } from '../history/history-store.js'
import {
  BOOKMARK_BONUS, TAB_BONUS, historyBonus, isCompletablePage, matchRanges, matchTier, stripAddress
} from './suggest.js'
import type { SuggestionRow } from './suggest.js'
import { engineSuggestions } from './suggest-fetch.js'
import type { SuggestDeps } from './suggest-fetch.js'

/** The pages the history offers for the text; `limit` bounds how many. */
const HISTORY_CANDIDATES = 60
const TAB_META = 'Switch to this tab'

export interface SuggestTab {
  id: string
  title: string
  /** What the tab loaded. */
  url: string
  /** The address as the person sees it. */
  displayUrl: string
  favicon: string | null
  /** The tab the person is on: offering it would send them where they already are. */
  current: boolean
  /** The dashboard or a blank page, which has nothing to come back to. */
  blank: boolean
}

export interface SuggestContext {
  now: number
  /** A private session offers nothing from history. */
  isPrivate: boolean
  history: { suggest: (text: string, limit: number) => readonly HistorySuggestion[] }
  bookmarks: () => readonly Bookmark[]
  tabs: () => readonly SuggestTab[]
  /** What the engine's own suggestions need; absent, none are asked for. */
  suggest?: SuggestDeps
}

export type SuggestSource = (text: string, ctx: SuggestContext) => SuggestionRow[]
export type LateSource = (text: string, ctx: SuggestContext, signal: AbortSignal) => Promise<SuggestionRow[]>

function rowFor (
  kind: 'history' | 'bookmark' | 'tab', text: string, page: { url: string, title: string, favicon: string | null }, score: number
): SuggestionRow {
  const address = stripAddress(page.url)
  const title = page.title === '' ? address : page.title
  return { kind, title, address, url: page.url, favicon: page.favicon, match: matchRanges(text, title), addressMatch: matchRanges(text, address), score }
}

const bookmarks: SuggestSource = (text, ctx) => {
  const rows: SuggestionRow[] = []
  for (const bookmark of ctx.bookmarks()) {
    const tier = matchTier(text, bookmark.title, stripAddress(bookmark.url))
    if (tier === 0) continue
    rows.push({ ...rowFor('bookmark', text, bookmark, tier + BOOKMARK_BONUS), completable: true })
  }
  return rows
}

const history: SuggestSource = (text, ctx) => {
  if (ctx.isPrivate) return []
  const rows: SuggestionRow[] = []
  for (const page of ctx.history.suggest(text, HISTORY_CANDIDATES)) {
    // SQLite's LIKE folds only ASCII, so a row it returned may still not match the way the text is read here.
    const tier = matchTier(text, page.title, stripAddress(page.url))
    if (tier === 0) continue
    const bonus = historyBonus({ visitCount: page.visitCount, typedCount: page.typedCount, lastVisit: page.lastVisit, now: ctx.now })
    rows.push({ ...rowFor('history', text, { url: page.url, title: page.title, favicon: null }, tier + bonus), completable: isCompletablePage(page) })
  }
  return rows
}

const tabs: SuggestSource = (text, ctx) => {
  const rows: SuggestionRow[] = []
  for (const tab of ctx.tabs()) {
    if (tab.current || tab.blank) continue
    const tier = matchTier(text, tab.title, stripAddress(tab.displayUrl))
    if (tier === 0) continue
    // The address the tab shows, as history keeps it: the row then folds into that page's history row and fills the
    // bar with `ipfs://...`, not the https URL such a page is served from. Switching goes by the tab's id.
    rows.push({
      ...rowFor('tab', text, { url: tab.displayUrl, title: tab.title, favicon: tab.favicon }, tier + TAB_BONUS),
      tabId: tab.id,
      meta: TAB_META
    })
  }
  return rows
}

/** One per line; the keywords of a later source go beside them. */
export const SUGGEST_SOURCES: readonly SuggestSource[] = [
  bookmarks,
  history,
  tabs
]

/** What the person types leaves this process only through a source listed here, and only when that source's own guards hold. */
export const LATE_SOURCES: readonly LateSource[] = [
  engineSuggestions
]
