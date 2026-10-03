import { describe, expect, it } from 'vitest'
import {
  MAX_ROWS, TIER_ADDRESS_PREFIX, TIER_SUBSTRING, TIER_WORD_PREFIX, dedupeKey, historyBonus, isCompletablePage, matchRanges, matchTier, placeLate, rank, stripAddress
} from '../suggest.js'
import type { SuggestionRow } from '../suggest.js'

const NOW = 1_000_000_000_000

function row (kind: SuggestionRow['kind'], url: string, score: number, more: Partial<SuggestionRow> = {}): SuggestionRow {
  return { kind, title: url, address: stripAddress(url), url, match: [], score, ...more }
}
const verbatim = (text: string): SuggestionRow => ({ kind: 'verbatim', title: text, address: '', url: `https://${text}/`, match: [], meta: 'Go to address' })
const search = (text: string): SuggestionRow => ({ kind: 'search', title: text, address: '', url: `https://search.test/?q=${text}`, match: [], meta: 'Search Test' })

describe('stripAddress and dedupeKey', () => {
  it.each([
    ['https://www.example.com/', 'example.com'],
    ['http://example.com', 'example.com'],
    ['https://example.com/a/b/', 'example.com/a/b'],
    ['ipfs://bafy/', 'bafy'],
    ['https://WWW.Example.com/Path?q=1', 'Example.com/Path?q=1']
  ])('%s is shown as %s', (url, shown) => {
    expect(stripAddress(url)).toBe(shown)
  })

  it('compares http://a.com/ and https://www.a.com as one page', () => {
    expect(dedupeKey('http://a.com/')).toBe(dedupeKey('https://www.a.com'))
    expect(dedupeKey('https://a.com/x')).not.toBe(dedupeKey('https://a.com/y'))
  })
})

describe('matchTier', () => {
  it.each([
    ['exa', 'Some page', 'example.com/docs', TIER_ADDRESS_PREFIX],
    ['docs', 'Some page', 'example.com/docs', TIER_WORD_PREFIX],
    ['some', 'Some page', 'other.org', TIER_WORD_PREFIX],
    ['page', 'Some page', 'other.org', TIER_WORD_PREFIX],
    ['ample', 'Some page', 'example.com', TIER_SUBSTRING],
    ['zzz', 'Some page', 'example.com', 0],
    ['https://www.exa', 'x', 'example.com', TIER_ADDRESS_PREFIX],
    ['some page', 'Some page', 'other.org', TIER_WORD_PREFIX],
    ['some zzz', 'Some page', 'other.org', 0],
    ['som ample', 'Some page', 'example.com', TIER_SUBSTRING],
    ['', 'x', 'y', 0]
  ])('%j against "%s" and %s is tier %i', (text, title, address, tier) => {
    expect(matchTier(text, title, address)).toBe(tier)
  })

  it('does not call a prefix of the whole address a prefix when there are several words', () => {
    expect(matchTier('exa docs', 'Some page', 'example.com/docs')).toBe(TIER_WORD_PREFIX)
  })
})

describe('matchRanges', () => {
  it('marks every occurrence of every word, ignoring case, and joins overlaps', () => {
    expect(matchRanges('exa ple', 'Example page example')).toEqual([[0, 3], [4, 7], [13, 16], [17, 20]])
  })

  it('finds a scheme-less word when a scheme was typed', () => {
    expect(matchRanges('https://www.exam', 'example.com')).toEqual([[0, 4]])
  })

  it('has no ranges for no match', () => {
    expect(matchRanges('zzz', 'example.com')).toEqual([])
  })
})

describe('historyBonus and isCompletablePage', () => {
  const base = { visitCount: 0, typedCount: 0, lastVisit: NOW, now: NOW }

  it('grows with visits up to a cap', () => {
    expect(historyBonus({ ...base, visitCount: 5 })).toBeGreaterThan(historyBonus({ ...base, visitCount: 1 }))
    expect(historyBonus({ ...base, visitCount: 500 })).toBe(historyBonus({ ...base, visitCount: 20 }))
  })

  it('grows with typed counts up to a cap, and more than visits do', () => {
    expect(historyBonus({ ...base, typedCount: 1 })).toBeGreaterThan(historyBonus({ ...base, visitCount: 1 }))
    expect(historyBonus({ ...base, typedCount: 99 })).toBe(historyBonus({ ...base, typedCount: 5 }))
  })

  it('halves the recency part in a week', () => {
    const fresh = historyBonus(base)
    const week = historyBonus({ ...base, lastVisit: NOW - 7 * 24 * 3600 * 1000 })
    expect(fresh).toBe(15 * 2)
    expect(week).toBe(15)
  })

  it('offers a page for completion once it was typed, or visited twice', () => {
    expect(isCompletablePage({ typedCount: 0, visitCount: 1 })).toBe(false)
    expect(isCompletablePage({ typedCount: 0, visitCount: 2 })).toBe(true)
    expect(isCompletablePage({ typedCount: 1, visitCount: 1 })).toBe(true)
  })
})

describe('rank', () => {
  it('puts what Enter does first, then the rest by score', () => {
    const { rows } = rank({
      text: 'exa', verbatim: verbatim('exa'), autocomplete: false,
      rows: [row('history', 'https://exa.org/a', 10), row('bookmark', 'https://exa.org/b', 50), row('history', 'https://exa.org/c', 30)]
    })
    expect(rows.map((r) => r.url)).toEqual(['https://exa/', 'https://exa.org/b', 'https://exa.org/c', 'https://exa.org/a'])
  })

  it('offers a search row first for text that is not an address', () => {
    const { rows } = rank({ text: 'cats', verbatim: search('cats'), autocomplete: false, rows: [] })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('search')
  })

  it('has no first row when nothing can be done with the text, and still lists pages', () => {
    const { rows } = rank({ text: 'x', verbatim: null, autocomplete: false, rows: [row('history', 'https://x.org/', 1)] })
    expect(rows.map((r) => r.kind)).toEqual(['history'])
  })

  it('shows one row for a page however it was spelled, preferring a tab over a bookmark over history', () => {
    const { rows } = rank({
      text: 'a', verbatim: null, autocomplete: false,
      rows: [
        row('history', 'http://a.com/', 90),
        row('bookmark', 'https://www.a.com', 10),
        row('tab', 'https://a.com', 5, { tabId: 't1' })
      ]
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'tab', score: 90 })
  })

  it('drops a page that row one already is', () => {
    const { rows } = rank({ text: 'a.com', verbatim: verbatim('a.com'), autocomplete: false, rows: [row('history', 'https://www.a.com', 99)] })
    expect(rows).toHaveLength(1)
  })

  it('lists at most two open tabs, ahead of the rest, and never more than eight rows', () => {
    const tabs = [1, 2, 3].map((n) => row('tab', `https://t${String(n)}.org/`, 10 + n, { tabId: `t${String(n)}` }))
    const pages = Array.from({ length: 12 }, (_, n) => row('history', `https://p${String(n)}.org/`, 100 + n))
    const { rows } = rank({ text: 'x', verbatim: verbatim('x'), autocomplete: false, rows: [...tabs, ...pages] })
    expect(rows).toHaveLength(MAX_ROWS)
    expect(rows.slice(1, 3).map((r) => r.kind)).toEqual(['tab', 'tab'])
    expect(rows.filter((r) => r.kind === 'tab').map((r) => r.tabId)).toEqual(['t3', 't2'])
  })

  describe('inline completion', () => {
    const page = (url: string, more: Partial<SuggestionRow> = {}): SuggestionRow => row('history', url, 50, { completable: true, ...more })

    it('finishes the host first', () => {
      const out = rank({ text: 'loc', verbatim: verbatim('loc'), autocomplete: true, rows: [page('http://localhost:3000/docs/intro')] })
      expect(out.completion).toBe('alhost:3000')
    })

    it('finishes the whole address once the host is typed and a slash after it', () => {
      const out = rank({ text: 'localhost:3000/', verbatim: verbatim('localhost:3000/'), autocomplete: true, rows: [page('http://localhost:3000/docs/intro')] })
      expect(out.completion).toBe('docs/intro')
    })

    it('adds nothing when the host is already typed in full', () => {
      const out = rank({ text: 'localhost:3000', verbatim: verbatim('x'), autocomplete: true, rows: [page('http://localhost:3000/docs')] })
      expect(out.completion).toBeNull()
    })

    it('ignores the scheme and www. in the text and in the page', () => {
      const out = rank({ text: 'https://www.exa', verbatim: verbatim('exa'), autocomplete: true, rows: [page('http://example.com/')] })
      expect(out.completion).toBe('mple.com')
    })

    it('keeps the case of the address it finishes with', () => {
      expect(rank({ text: 'git', verbatim: verbatim('git'), autocomplete: true, rows: [page('https://GitHub.com/')] }).completion).toBe('Hub.com')
    })

    it('makes row one the finished page, with its favicon and title, and lists the page it came from only once', () => {
      const icon = 'data:image/png;base64,AA=='
      const out = rank({
        text: 'exa', verbatim: verbatim('exa'), autocomplete: true, resolve: (text) => `https://${text}/`,
        rows: [page('https://example.com/', { title: 'Example', favicon: icon })]
      })
      expect(out.rows).toHaveLength(1)
      expect(out.rows[0]).toMatchObject({ kind: 'history', title: 'Example', address: 'example.com', url: 'https://example.com/', favicon: icon })
    })

    it('titles the row with the host when the page it was finished from is deeper', () => {
      const out = rank({
        text: 'exa', verbatim: verbatim('exa'), autocomplete: true, resolve: (text) => `https://${text}/`,
        rows: [page('https://example.com/deep', { title: 'Deep' })]
      })
      // A host finished from a deeper page is an address, not that page: no star, no title of its own.
      expect(out.rows[0]).toMatchObject({ kind: 'history', title: 'example.com', url: 'https://example.com/' })
      expect(out.rows[1]).toMatchObject({ title: 'Deep' })
    })

    it('keeps a bookmark a bookmark when the whole address was finished from it', () => {
      const out = rank({
        text: 'example.com/', verbatim: verbatim('x'), autocomplete: true, resolve: (text) => `https://${text}`,
        rows: [row('bookmark', 'https://example.com/docs', 50, { title: 'Docs', completable: true })]
      })
      expect(out.rows[0]).toMatchObject({ kind: 'bookmark', title: 'Docs', address: 'example.com/docs' })
    })

    it('does not finish with a page visited once and never typed', () => {
      const out = rank({ text: 'exa', verbatim: verbatim('exa'), autocomplete: true, rows: [row('history', 'https://example.com/', 50, { completable: false })] })
      expect(out.completion).toBeNull()
    })

    it('does not finish when nothing begins with the text', () => {
      const out = rank({ text: 'pl', verbatim: verbatim('pl'), autocomplete: true, rows: [page('https://example.com/')] })
      expect(out.completion).toBeNull()
    })

    it('does not finish when autocomplete is off, for text with a space, or for a forced search', () => {
      const rows = [page('https://example.com/')]
      expect(rank({ text: 'exa', verbatim: verbatim('exa'), autocomplete: false, rows }).completion).toBeNull()
      expect(rank({ text: 'exa mple', verbatim: verbatim('exa'), autocomplete: true, rows }).completion).toBeNull()
      expect(rank({ text: 'exa ', verbatim: verbatim('exa '), autocomplete: true, rows }).completion).toBeNull()
      expect(rank({ text: ' exa', verbatim: verbatim(' exa'), autocomplete: true, rows }).completion).toBe('mple.com')
      expect(rank({ text: '?exa', verbatim: search('exa'), autocomplete: true, rows }).completion).toBeNull()
    })

    it('takes the best of several pages', () => {
      const out = rank({
        text: 'ex', verbatim: verbatim('ex'), autocomplete: true,
        rows: [page('https://example.org/', { score: 10 }), page('https://exam.com/', { score: 90 })]
      })
      expect(out.completion).toBe('am.com')
    })
  })
})

describe('placeLate', () => {
  const held = [verbatim('q'), ...['a', 'b', 'c', 'd'].map((id) => row('history', `https://${id}.org/`, 1))]
  const late = ['x', 'y', 'z', 'w', 'v'].map((id) => row('history', `https://${id}.org/`, 1))

  it('fills positions two to five and leaves row one where it is', () => {
    const out = placeLate(held, late, 0)
    expect(out[0]).toBe(held[0])
    expect(out.slice(1, 5).map((r) => r.url)).toEqual(['https://x.org/', 'https://y.org/', 'https://z.org/', 'https://w.org/'])
    expect(out).toHaveLength(8)
  })

  it('never moves the selected row: new rows go after it', () => {
    const out = placeLate(held, late, 2)
    expect(out.slice(0, 3)).toEqual(held.slice(0, 3))
    expect(out[3]?.url).toBe('https://x.org/')
    expect(out.indexOf(held[2] as SuggestionRow)).toBe(2)
  })

  it('adds nothing when the selection is already past position five', () => {
    expect(placeLate(held, late, 4)).toEqual(held)
  })

  it('leaves out a page that is already shown', () => {
    const out = placeLate(held, [row('history', 'http://www.a.org', 1), late[0] as SuggestionRow], 0)
    expect(out.filter((r) => r.url?.includes('a.org'))).toHaveLength(1)
    expect(out[1]?.url).toBe('https://x.org/')
  })

  it('keeps at most eight rows', () => {
    const many = Array.from({ length: 8 }, (_, n) => row('history', `https://m${String(n)}.org/`, 1))
    expect(placeLate([verbatim('q'), ...many], late, 0).length).toBeLessThanOrEqual(MAX_ROWS)
  })
})
