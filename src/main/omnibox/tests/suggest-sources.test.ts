import { describe, expect, it, vi } from 'vitest'
import type { Bookmark } from '../../browsing/bookmarks.js'
import type { HistorySuggestion } from '../../history/history-store.js'
import { engineSuggestions } from '../suggest-fetch.js'
import { LATE_SOURCES, SUGGEST_SOURCES } from '../suggest-sources.js'
import type { SuggestContext, SuggestTab } from '../suggest-sources.js'

const NOW = 1_700_000_000_000
const page = (url: string, title: string, more: Partial<HistorySuggestion> = {}): HistorySuggestion => ({ url, title, visitCount: 1, typedCount: 0, lastVisit: NOW, ...more })
const tab = (id: string, url: string, title: string, more: Partial<SuggestTab> = {}): SuggestTab => ({ id, url, title, displayUrl: url, favicon: null, current: false, blank: false, ...more })

function context (more: { history?: HistorySuggestion[], bookmarks?: Bookmark[], tabs?: SuggestTab[], isPrivate?: boolean } = {}): SuggestContext {
  return {
    now: NOW,
    isPrivate: more.isPrivate ?? false,
    history: { suggest: vi.fn(() => more.history ?? []) },
    bookmarks: () => more.bookmarks ?? [],
    tabs: () => more.tabs ?? []
  }
}
const all = (text: string, ctx: SuggestContext): ReturnType<(typeof SUGGEST_SOURCES)[number]> => SUGGEST_SOURCES.flatMap((source) => source(text, ctx))

describe('the suggestion sources', () => {
  it('reads the bookmarks, the history and the tabs, in that order', () => {
    const rows = all('exa', context({
      bookmarks: [{ url: 'https://exa.org/', title: 'Bookmarked', favicon: null }],
      history: [page('https://exa.com/', 'Visited')],
      tabs: [tab('t1', 'https://exa.net/', 'Open')]
    }))
    expect(rows.map((row) => row.kind)).toEqual(['bookmark', 'history', 'tab'])
  })

  it('scores a bookmark above the same match in the history, and offers it for completion', () => {
    const [bookmark, visited] = all('exa', context({ bookmarks: [{ url: 'https://exa.org/', title: 'B', favicon: null }], history: [page('https://exa.com/', 'H')] }))
    expect(bookmark?.score).toBeGreaterThan(visited?.score ?? Infinity)
    expect(bookmark?.completable).toBe(true)
    expect(visited?.completable).toBe(false)
  })

  it('offers a history page for completion once it was typed or visited twice', () => {
    const rows = all('exa', context({ history: [page('https://exa.com/', 'a', { typedCount: 1 }), page('https://exa.org/', 'b', { visitCount: 2 }), page('https://exa.net/', 'c')] }))
    expect(rows.map((row) => row.completable)).toEqual([true, true, false])
  })

  it('drops a history row the text does not match the way it is read here (a case LIKE did not fold)', () => {
    expect(all('ÉCOLE', context({ history: [page('https://x.org/', 'école')] }))).toHaveLength(1)
    expect(all('zzz', context({ history: [page('https://x.org/', 'école')] }))).toHaveLength(0)
  })

  it('reads no history for a private session, and does not even ask', () => {
    const ctx = context({ isPrivate: true, history: [page('https://exa.com/', 'H')], bookmarks: [{ url: 'https://exa.org/', title: 'B', favicon: null }] })
    expect(all('exa', ctx).map((row) => row.kind)).toEqual(['bookmark'])
    expect(ctx.history.suggest).not.toHaveBeenCalled()
  })

  it('skips the tab the person is on and a blank tab, and says what choosing a tab does', () => {
    const rows = all('exa', context({ tabs: [tab('t1', 'https://exa.org/', 'Here', { current: true }), tab('t2', 'https://exa.com/', 'Blank', { blank: true }), tab('t3', 'https://exa.net/', 'There')] }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'tab', tabId: 't3', meta: 'Switch to this tab', url: 'https://exa.net/' })
  })

  it('shows a tab by the address the person sees, and a page with no title by its address', () => {
    const [row] = all('bafy', context({ tabs: [tab('t1', 'https://ipfs.orivon/bafy/', 'bafy page', { displayUrl: 'ipfs://bafy/' })] }))
    expect(row?.address).toBe('bafy')
    const [untitled] = all('exa', context({ history: [page('https://exa.com/', '')] }))
    expect(untitled?.title).toBe('exa.com')
  })

  it('marks what matched, in the title and in the address', () => {
    const [row] = all('exa', context({ history: [page('https://exa.com/', 'The exa page')] }))
    expect(row?.match).toEqual([[4, 7]])
    expect(row?.addressMatch).toEqual([[0, 3]])
  })

  it('has one source that waits, the engine suggestions, and it asks for nothing unless the window says so', async () => {
    expect(LATE_SOURCES).toEqual([engineSuggestions])
    expect(await engineSuggestions('cats', context({}), new AbortController().signal)).toEqual([])
  })
})
