import { describe, expect, it } from 'vitest'
import { parseOmniboxInput } from '../../browsing/omnibox.js'
import { GO_TO_ADDRESS, forcedQuery, verbatimRow } from '../verbatim-row.js'

const search = (query: string): string => `https://search.test/?q=${encodeURIComponent(query)}`
const deps = (engineName = 'Test Search') => ({
  classify: (text: string) => parseOmniboxInput(text, () => false, search),
  isInternal: (text: string) => text.startsWith('orivon://'),
  engineName
})

describe('forcedQuery', () => {
  it.each([['? cats', 'cats'], ['?cats', 'cats'], ['?', ''], ['cats', null], [' ?x', 'x']])('%j gives %j', (text, query) => {
    expect(forcedQuery(text)).toBe(query)
  })
})

describe('verbatimRow', () => {
  it('goes to an address, as typed', () => {
    expect(verbatimRow('example.com', deps())).toMatchObject({ kind: 'verbatim', title: 'example.com', url: 'https://example.com/', meta: GO_TO_ADDRESS })
  })

  it('searches the engine for text that is not an address', () => {
    expect(verbatimRow('cats and dogs', deps())).toMatchObject({ kind: 'search', title: 'cats and dogs', url: search('cats and dogs'), meta: 'Search Test Search' })
  })

  it('searches for what follows a question mark, even an address', () => {
    expect(verbatimRow('? example.com', deps())).toMatchObject({ kind: 'search', title: 'example.com', url: search('example.com') })
  })

  it('names no engine for the person\'s own address', () => {
    expect(verbatimRow('cats', deps(''))?.meta).toBe('Search the web')
  })

  it('goes to one of the shell\'s own pages, which is opened before anything is classified', () => {
    expect(verbatimRow('orivon://history', deps())).toMatchObject({ kind: 'verbatim', url: 'orivon://history' })
  })

  it.each(['', '   ', '?', 'javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd'])('offers nothing for %j', (text) => {
    expect(verbatimRow(text, deps())).toBeNull()
  })
})
