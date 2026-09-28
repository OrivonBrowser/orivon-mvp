import { describe, expect, it } from 'vitest'
import { CUSTOM_SEARCH_ENGINE, DEFAULT_SEARCH_ENGINE, SEARCH_ENGINES, isValidSearchTemplate, searchUrlFor } from '../search-engines.js'
import { parseOmniboxInput } from '../omnibox.js'

describe('searchUrlFor', () => {
  it('sends the default engine exactly the URL the address bar always built', () => {
    expect(searchUrlFor(DEFAULT_SEARCH_ENGINE, '', 'hello world')).toBe('https://duckduckgo.com/?q=hello+world')
  })

  it('encodes what would change the URL\'s shape', () => {
    expect(searchUrlFor('brave', '', 'a&b=c#d+e')).toBe('https://search.brave.com/search?q=a%26b%3Dc%23d%2Be')
  })

  it('has a template for every listed engine, each of them https with one placeholder', () => {
    for (const engine of SEARCH_ENGINES) {
      expect(engine.template.startsWith('https://')).toBe(true)
      expect(engine.template.split('%s')).toHaveLength(2)
      expect(isValidSearchTemplate(engine.template)).toBe(true)
    }
  })

  it('falls back to the default for an engine it does not know', () => {
    expect(searchUrlFor('nonesuch', '', 'x')).toBe(searchUrlFor(DEFAULT_SEARCH_ENGINE, '', 'x'))
  })

  it('uses a person\'s own template for the custom engine', () => {
    expect(searchUrlFor(CUSTOM_SEARCH_ENGINE, 'https://search.example/find?text=%s&safe=1', 'a b')).toBe('https://search.example/find?text=a+b&safe=1')
  })

  it('falls back to the default when the custom template is unusable', () => {
    expect(searchUrlFor(CUSTOM_SEARCH_ENGINE, '', 'x')).toBe(searchUrlFor(DEFAULT_SEARCH_ENGINE, '', 'x'))
    expect(searchUrlFor(CUSTOM_SEARCH_ENGINE, 'http://insecure.example/?q=%s', 'x')).toBe(searchUrlFor(DEFAULT_SEARCH_ENGINE, '', 'x'))
  })
})

describe('isValidSearchTemplate', () => {
  it.each([
    ['https://search.example/?q=%s', true],
    ['https://search.example/%s', true],
    ['https://search.example/?q=%s&also=%s', true],
    ['http://localhost:8080/search?q=%s', true],
    ['http://127.0.0.1/?q=%s', true],
    ['http://search.example/?q=%s', false],
    ['https://search.example/?q=', false],
    ['https://%s.example/', false],
    ['https://search.example%s/', false],
    ['https://user:pass@search.example/?q=%s', false],
    ['javascript:alert(%s)', false],
    ['ftp://search.example/?q=%s', false],
    ['search.example/?q=%s', false],
    ['https:///?q=%s', false],
    [`https://search.example/?q=%s${'a'.repeat(2100)}`, false]
  ])('%s -> %s', (template, expected) => {
    expect(isValidSearchTemplate(template)).toBe(expected)
  })
})

describe('parseOmniboxInput with a search function', () => {
  it('sends non-address input through it', () => {
    const result = parseOmniboxInput('what is a light client', () => false, (query) => `https://search.example/?q=${encodeURIComponent(query)}`)

    expect(result).toEqual({ kind: 'search', url: 'https://search.example/?q=what%20is%20a%20light%20client' })
  })

  it('still treats an address as an address', () => {
    const result = parseOmniboxInput('example.com', () => false, () => 'https://never.example/')

    expect(result).toEqual({ kind: 'url', url: 'https://example.com/' })
  })
})
