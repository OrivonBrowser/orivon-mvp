import { describe, expect, it } from 'vitest'
import { resolveCurrent } from '../search-current.js'
import { SEARCH_ENGINES } from '../search-engines.js'
import { defaultEngineFor, resolveSearch } from '../search-resolve.js'
import type { EngineView } from '../search-resolve.js'
import { SITE_ENGINE_SEEDS } from '../site-engines.js'

const builtIn: EngineView[] = SEARCH_ENGINES.map((engine) => ({ id: engine.id, name: engine.label, keyword: engine.keyword, template: engine.template, kind: 'builtin' }))
const site: EngineView[] = SITE_ENGINE_SEEDS.map((seed) => ({ ...seed, kind: 'site' }))
const engines = [...builtIn, ...site]
const fallback = defaultEngineFor('duckduckgo', '', engines)

describe('resolveSearch', () => {
  it('searches the engine a keyword names, with what follows it', () => {
    expect(resolveSearch('w solar eclipse', engines, fallback)).toEqual({
      engine: { id: 'seed-wikipedia', name: 'Wikipedia' },
      terms: 'solar eclipse',
      url: 'https://en.wikipedia.org/w/index.php?search=solar+eclipse',
      byKeyword: true
    })
  })

  it('reads a keyword whatever its case', () => {
    expect(resolveSearch('YT lofi', engines, fallback)).toMatchObject({ engine: { name: 'YouTube' }, terms: 'lofi', byKeyword: true })
  })

  it('goes to the default with the whole text when the keyword stands alone', () => {
    expect(resolveSearch('w', engines, fallback)).toMatchObject({ engine: { id: 'duckduckgo' }, terms: 'w', url: 'https://duckduckgo.com/?q=w', byKeyword: false })
    expect(resolveSearch('w   ', engines, fallback).byKeyword).toBe(false)
  })

  it('goes to the default with the whole text for a word that is not a keyword', () => {
    expect(resolveSearch('weather in rome', engines, fallback)).toMatchObject({ terms: 'weather in rome', byKeyword: false })
  })

  it('takes only a whole first word: an address-shaped first word is no keyword', () => {
    expect(resolveSearch('w.com cats', engines, fallback)).toMatchObject({ terms: 'w.com cats', byKeyword: false })
    expect(resolveSearch('w/x cats', engines, fallback).byKeyword).toBe(false)
  })

  it('encodes the terms as a search box does', () => {
    expect(resolveSearch('gh a&b c#d', engines, fallback).url).toBe('https://github.com/search?q=a%26b+c%23d')
  })

  it('no longer knows the keyword of a removed engine', () => {
    const without = engines.filter((engine) => engine.id !== 'seed-wikipedia')
    expect(resolveSearch('w cats', without, fallback)).toMatchObject({ terms: 'w cats', byKeyword: false })
  })

  it('finds a person\'s own engine, and the built-in ones by their fixed keywords', () => {
    const own: EngineView = { id: 'e-1', name: 'Docs', keyword: 'Docs', template: 'https://docs.example/?s=%s', kind: 'custom' }
    expect(resolveSearch('docs api', [...engines, own], fallback)).toMatchObject({ engine: { id: 'e-1' }, url: 'https://docs.example/?s=api' })
    expect(resolveSearch('ddg cats', engines, fallback)).toMatchObject({ engine: { name: 'DuckDuckGo' }, terms: 'cats' })
    expect(resolveSearch('g cats', engines, fallback).url).toBe('https://www.google.com/search?q=cats')
  })

  it('trims the text and the terms', () => {
    expect(resolveSearch('  w    cats  ', engines, fallback)).toMatchObject({ terms: 'cats', byKeyword: true })
  })
})

describe('defaultEngineFor', () => {
  it('names a built-in choice', () => {
    expect(defaultEngineFor('brave', '', engines)).toEqual({ id: 'brave', name: 'Brave Search', template: 'https://search.brave.com/search?q=%s' })
  })

  it('names a custom address after the engine whose address it is, and leaves an unknown one unnamed', () => {
    expect(defaultEngineFor('custom', 'https://github.com/search?q=%s', engines)).toMatchObject({ id: 'seed-github', name: 'GitHub' })
    expect(defaultEngineFor('custom', 'https://mine.example/?q=%s', engines)).toEqual({ id: 'custom', name: '', template: 'https://mine.example/?q=%s' })
  })

  it('falls back to the first engine for a custom choice with no usable address', () => {
    expect(defaultEngineFor('custom', 'http://insecure.example/?q=%s', engines)).toMatchObject({ id: 'duckduckgo' })
  })
})

describe('resolveCurrent', () => {
  it('reads the settings and the engines it is given', () => {
    const sources = {
      settings: { get: (key: 'search.engine' | 'search.customUrl') => key === 'search.engine' ? 'custom' : 'https://mine.example/?q=%s' },
      searchEngines: { all: () => engines }
    }
    expect(resolveCurrent(sources, 'cats').url).toBe('https://mine.example/?q=cats')
    expect(resolveCurrent(sources, 'w cats').url).toBe('https://en.wikipedia.org/w/index.php?search=cats')
  })
})
