import { describe, expect, it } from 'vitest'
import type { Row, Section } from '../settings/model.js'
import { searchRows } from '../settings/search.js'

const row = (id: string, label: string, extra: Partial<Row> = {}): Row => ({ id, label, control: { type: 'info', text: () => '' }, ...extra })

const SECTIONS: readonly Section[] = [
  { id: 'appearance', title: 'Appearance', rows: [
    row('theme', 'Theme', { help: 'Light or dark for the browser and sites.', keywords: ['night', 'colour'] }),
    row('bar', 'Bookmarks bar', { help: 'The row under the address bar.' })
  ] },
  { id: 'search', title: 'Search', rows: [
    row('engine', 'Search engine', { keywords: ['duckduckgo', 'google'] }),
    row('custom', 'Your search address', { help: 'Where a search engine of your own lives.', visible: () => false })
  ] }
]
const shown = (r: Row): boolean => r.visible?.({} as never) ?? true

describe('searchRows', () => {
  it('finds nothing for an empty query', () => {
    expect(searchRows(SECTIONS, '   ', shown)).toEqual([])
  })

  it('matches a label, a help word, a keyword and a section title, without regard to case', () => {
    expect(searchRows(SECTIONS, 'THEME', shown).map((hit) => hit.row.id)).toEqual(['theme'])
    expect(searchRows(SECTIONS, 'address', shown).map((hit) => hit.row.id)).toEqual(['bar'])
    expect(searchRows(SECTIONS, 'night', shown).map((hit) => hit.row.id)).toEqual(['theme'])
    expect(searchRows(SECTIONS, 'appearance', shown).map((hit) => hit.row.id)).toEqual(['theme', 'bar'])
  })

  it('needs every word of the query', () => {
    expect(searchRows(SECTIONS, 'search google', shown).map((hit) => hit.row.id)).toEqual(['engine'])
    expect(searchRows(SECTIONS, 'search nothing', shown)).toEqual([])
  })

  it('ranks a label that starts with the query before one that contains it, before help, and keeps page order between equals', () => {
    const sections: readonly Section[] = [{ id: 's', title: 'S', rows: [
      row('a', 'A place for bar codes', { help: 'unrelated' }),
      row('b', 'Bar', { help: 'unrelated' }),
      row('c', 'The Bar', { help: 'unrelated' }),
      row('d', 'Other', { help: 'about a bar' })
    ] }]

    expect(searchRows(sections, 'bar', shown).map((hit) => hit.row.id)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('does not find a row that is not shown', () => {
    expect(searchRows(SECTIONS, 'search address', shown)).toEqual([])
    expect(searchRows(SECTIONS, 'search address', () => true).map((hit) => hit.row.id)).toEqual(['custom'])
  })

  it('reports the section each hit belongs to', () => {
    const [hit] = searchRows(SECTIONS, 'engine', shown)

    expect(hit?.section.id).toBe('search')
  })
})
