import { describe, expect, it, vi } from 'vitest'
import { OmniboxService, hostKey } from '../omnibox-service.js'
import type { OmniboxDeps, Snapshot } from '../omnibox-service.js'
import type { SuggestionRow } from '../suggest.js'
import type { LateSource, SuggestContext, SuggestSource } from '../suggest-sources.js'

const page = (url: string, more: Partial<SuggestionRow> = {}): SuggestionRow => ({
  kind: 'history', title: url, address: url.replace(/^https?:\/\//, '').replace(/\/$/, ''), url, match: [], score: 10, ...more
})
const goTo = (text: string): SuggestionRow => ({ kind: 'verbatim', title: text, address: '', url: `https://${text}/`, match: [], meta: 'Go to address' })

function make (rows: SuggestionRow[] = [], more: Partial<OmniboxDeps> = {}): { service: OmniboxService, late: Snapshot[], deps: OmniboxDeps } {
  const late: Snapshot[] = []
  const source: SuggestSource = () => rows
  const deps: OmniboxDeps = {
    context: () => ({ now: 0, isPrivate: false, history: { suggest: () => [] }, bookmarks: () => [], tabs: () => [] }) satisfies SuggestContext,
    verbatim: (text) => text.trim() === '' ? null : goTo(text),
    autocomplete: () => true,
    resolve: (text) => `https://${text}/`,
    faviconsFor: () => ({}),
    onLate: (snapshot) => { late.push(snapshot) },
    sources: [source],
    lateSources: [],
    ...more
  }
  return { service: new OmniboxService(deps), late, deps }
}

describe('OmniboxService.query', () => {
  it('numbers each query, and answers how many rows and what to finish the text with', () => {
    const { service } = make([page('https://example.com/', { completable: true })])
    const first = service.query('exa', true)
    const second = service.query('exam', true)
    expect(second.seq).toBe(first.seq + 1)
    // The finished page is the first row, and the row it came from is not listed again.
    expect(first).toMatchObject({ count: 1, completion: 'mple.com' })
  })

  it('finishes the text only when it was typed, and only with the setting on', () => {
    const rows = [page('https://example.com/', { completable: true })]
    expect(make(rows).service.query('exa', false).completion).toBeNull()
    expect(make(rows, { autocomplete: () => false }).service.query('exa', true).completion).toBeNull()
  })

  it('holds no rows for empty text', () => {
    const { service } = make([page('https://example.com/')])
    expect(service.query('  ', true)).toMatchObject({ count: 0, completion: null })
    expect(service.snapshot().rows).toEqual([])
  })

  it('hands the page rows without an address to open or a score', () => {
    const { service } = make([page('https://example.com/', { tabId: 'x', completable: true })])
    service.query('exa', false)
    for (const row of service.snapshot().rows) {
      expect(Object.keys(row).sort()).toEqual(['addressMatch', 'address', 'favicon', 'kind', 'match', 'meta', 'title'].sort())
    }
  })

  it('fills each history row with the icon its host has, and leaves the rest alone', () => {
    const faviconsFor = vi.fn(() => ({ 'example.com': 'data:image/png;base64,AA==' }))
    const { service } = make([page('https://example.com/a'), page('https://other.org/', { favicon: 'data:image/png;base64,BB==' }), page('https://none.net/')], { faviconsFor })
    service.query('x', false)
    const icons = service.snapshot().rows.map((row) => row.favicon)
    expect(icons).toEqual([null, 'data:image/png;base64,AA==', 'data:image/png;base64,BB==', null])
    expect(faviconsFor).toHaveBeenCalledWith(['example.com', 'none.net'])
  })
})

describe('OmniboxService.select', () => {
  it('moves down and up, wrapping, and says what the bar shows for the row', () => {
    const { service } = make([page('https://a.org/'), page('https://b.org/', { score: 5 })])
    const { seq } = service.query('x', false)
    expect(service.select(1, seq)).toEqual({ selected: 1, fill: 'https://a.org/' })
    expect(service.select(1, seq)).toEqual({ selected: 2, fill: 'https://b.org/' })
    expect(service.select(1, seq)).toEqual({ selected: 0, fill: null })
    expect(service.select(-1, seq)).toEqual({ selected: 2, fill: 'https://b.org/' })
    expect(service.snapshot().selected).toBe(2)
  })

  it('shows the words of a search row, not an address', () => {
    const { service } = make([], { verbatim: () => ({ kind: 'search', title: 'cats', address: '', url: 'https://s/?q=cats', match: [] }) })
    service.query('cats', false)
    service.query('cats', false)
    expect(service.select(-1, undefined)).toEqual({ selected: 0, fill: null })
  })

  it('ignores an answer meant for an older list, and a list with nothing in it', () => {
    const { service } = make([page('https://a.org/')])
    const old = service.query('a', false).seq
    service.query('ab', false)
    expect(service.select(1, old)).toBeUndefined()
    service.query('', false)
    expect(service.select(1, undefined)).toBeUndefined()
  })
})

describe('OmniboxService.pick', () => {
  function withRows (): { service: OmniboxService, seq: number } {
    const { service } = make([
      page('https://a.org/', { kind: 'bookmark' }),
      page('https://b.org/', { kind: 'tab', tabId: 'tab-7', score: 9 }),
      page('https://c.org/', { score: 8 })
    ])
    return { service, seq: service.query('some text', false).seq }
  }

  it('goes to the text as typed for the first row, and to the held address for any other', () => {
    const { service, seq } = withRows()
    expect(service.pick(0, 'current', seq)).toEqual({ type: 'go', disposition: 'current', target: 'some text', markTyped: 'https://some text/' })
    expect(service.pick(0, 'tab', seq)).toEqual({ type: 'go', disposition: 'tab', target: 'https://some text/', markTyped: 'https://some text/' })
    expect(service.pick(2, 'current', seq)).toEqual({ type: 'go', disposition: 'current', target: 'https://a.org/', markTyped: 'https://a.org/' })
    expect(service.pick(3, 'background', seq)).toEqual({ type: 'go', disposition: 'background', target: 'https://c.org/', markTyped: 'https://c.org/' })
  })

  it('switches to the tab of a tab row whatever the disposition', () => {
    const { service, seq } = withRows()
    expect(service.pick(1, 'current', seq)).toEqual({ type: 'switch', tabId: 'tab-7' })
    expect(service.pick(1, 'background', seq)).toEqual({ type: 'switch', tabId: 'tab-7' })
  })

  it.each([-1, 4, 99, 1.5, Number.NaN])('refuses the index %s, which is outside the held list', (index) => {
    const { service, seq } = withRows()
    expect(service.pick(index, 'current', seq)).toBeUndefined()
  })

  it('refuses a choice made on a list that has since changed, but takes one with no number', () => {
    const { service, seq } = withRows()
    service.query('other', false)
    expect(service.pick(2, 'current', seq)).toBeUndefined()
    expect(service.pick(2, 'current', undefined)).toMatchObject({ type: 'go' })
  })

  it('holds nothing after it was reset', () => {
    const { service, seq } = withRows()
    service.reset()
    expect(service.pick(0, 'current', seq)).toBeUndefined()
    expect(service.pick(0, 'current', undefined)).toBeUndefined()
    expect(service.snapshot().rows).toEqual([])
  })
})

describe('a source that answers late', () => {
  function later (rows: SuggestionRow[], gate: { resolve: () => void }): LateSource {
    return async () => { await new Promise<void>((resolve) => { gate.resolve = resolve }); return rows }
  }
  const lateRows = ['x', 'y', 'z'].map((id) => page(`https://${id}.org/`))

  it('puts its rows in positions two to five after the first paint, and tells the page', async () => {
    const gate = { resolve: () => {} }
    const { service, late } = make([page('https://a.org/')], { lateSources: [later(lateRows, gate)] })
    service.query('q', false)
    expect(service.snapshot().rows).toHaveLength(2)
    gate.resolve()
    await vi.waitFor(() => { expect(late).toHaveLength(1) })
    expect(late[0]?.rows.map((row) => row.title)).toEqual(['q', 'https://x.org/', 'https://y.org/', 'https://z.org/', 'https://a.org/'])
  })

  it('never moves a row the person has already selected', async () => {
    const gate = { resolve: () => {} }
    const { service, late } = make([page('https://a.org/'), page('https://b.org/', { score: 1 })], { lateSources: [later(lateRows, gate)] })
    const { seq } = service.query('q', false)
    service.select(1, seq)
    service.select(1, seq)
    gate.resolve()
    await vi.waitFor(() => { expect(late).toHaveLength(1) })
    expect(late[0]?.selected).toBe(2)
    expect(late[0]?.rows.slice(0, 3).map((row) => row.title)).toEqual(['q', 'https://a.org/', 'https://b.org/'])
  })

  it('drops rows that arrive for a text that was since replaced or closed', async () => {
    const gate = { resolve: () => {} }
    const { service, late } = make([page('https://a.org/')], { lateSources: [later(lateRows, gate)] })
    service.query('q', false)
    service.reset()
    gate.resolve()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(late).toEqual([])
  })

  it('takes no more than a failing source gave', async () => {
    const { service, late } = make([page('https://a.org/')], { lateSources: [async () => { throw new Error('offline') }] })
    service.query('q', false)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(late).toEqual([])
    expect(service.snapshot().rows).toHaveLength(2)
  })
})

describe('hostKey', () => {
  it.each([['https://www.example.com/a', 'www.example.com'], ['http://localhost:3000/', 'localhost'], ['not a url', '']])('%s is %j', (url, host) => {
    expect(hostKey(url)).toBe(host)
  })
})
