import { describe, expect, it } from 'vitest'
import { currentDefault, currentSearchUrl, engineNames, resolveCurrent, web3EngineNow } from '../search-current.js'
import type { SearchSources } from '../search-current.js'
import { SEARCH_ENGINES } from '../search-engines.js'
import type { EngineView } from '../search-resolve.js'
import { SITE_ENGINE_SEEDS } from '../site-engines.js'

const builtIn: EngineView[] = SEARCH_ENGINES.map((engine) => ({ id: engine.id, name: engine.label, keyword: engine.keyword, template: engine.template, kind: 'builtin' }))
const site: EngineView[] = SITE_ENGINE_SEEDS.map((seed) => ({ ...seed, kind: 'site' }))

function sources (values: Record<string, string> = {}): SearchSources {
  const all = { 'search.mode': 'web3', 'search.web3Engine': 'explore', 'search.engine': 'duckduckgo', 'search.customUrl': '', ...values }
  return { settings: { get: (key) => all[key] as string }, searchEngines: { all: () => [...builtIn, ...site] } }
}

describe('the default engine of the address bar', () => {
  it('is Explore in Web3 mode, named so the dropdown can say it', () => {
    expect(currentDefault(sources())).toEqual({ id: 'explore', name: 'Explore', template: 'ipfs://explore.orivonstack.eth/#/search?q=%s' })
  })

  it('is the Web2 engine in Web2 mode', () => {
    expect(currentDefault(sources({ 'search.mode': 'web2' }))).toMatchObject({ id: 'duckduckgo', name: 'DuckDuckGo' })
    expect(currentDefault(sources({ 'search.mode': 'web2', 'search.engine': 'brave' }))).toMatchObject({ id: 'brave', name: 'Brave Search' })
  })

  it('does not let the Web2 choice change the Web3 engine, nor the reverse', () => {
    expect(currentDefault(sources({ 'search.engine': 'brave' })).id).toBe('explore')
    expect(currentDefault(sources({ 'search.mode': 'web2', 'search.web3Engine': 'nonesuch' })).id).toBe('duckduckgo')
  })

  it('falls back to the first Web3 engine for an id it does not know', () => {
    expect(currentDefault(sources({ 'search.web3Engine': 'nonesuch' })).id).toBe('explore')
  })
})

describe('resolveCurrent', () => {
  it('sends a plain query to Explore in Web3 mode, as the form a search box submits, at the address a tab loads Explore from', () => {
    expect(resolveCurrent(sources(), 'free speech')).toMatchObject({
      engine: { id: 'explore', name: 'Explore' },
      url: 'https://explore.orivonstack.eth/#/search?q=free+speech',
      byKeyword: false
    })
  })

  it('sends it to the Web2 engine in Web2 mode', () => {
    expect(resolveCurrent(sources({ 'search.mode': 'web2' }), 'free speech').url).toBe('https://duckduckgo.com/?q=free+speech')
  })

  it('keeps a keyword working in both modes', () => {
    for (const mode of ['web3', 'web2']) {
      expect(resolveCurrent(sources({ 'search.mode': mode }), 'w solar eclipse')).toMatchObject({
        engine: { name: 'Wikipedia' },
        url: 'https://en.wikipedia.org/w/index.php?search=solar+eclipse',
        byKeyword: true
      })
    }
  })
})

describe('the engine without the engine store', () => {
  it('names the Web3 engine in Web3 mode and none in Web2 mode', () => {
    expect(web3EngineNow(sources().settings)).toMatchObject({ id: 'explore', label: 'Explore' })
    expect(web3EngineNow(sources({ 'search.mode': 'web2' }).settings)).toBeNull()
  })

  it('builds the same address the address bar does, for the menus and extensions that have only settings', () => {
    expect(currentSearchUrl(sources().settings, 'a b')).toBe('https://explore.orivonstack.eth/#/search?q=a+b')
    expect(currentSearchUrl(sources({ 'search.mode': 'web2', 'search.engine': 'custom', 'search.customUrl': 'https://s.example/?t=%s' }).settings, 'a b')).toBe('https://s.example/?t=a+b')
  })
})

describe('engineNames', () => {
  it('names the engine of each mode whichever mode is on, so a control can say what a switch does', () => {
    expect(engineNames(sources())).toEqual({ web3: 'Explore', web2: 'DuckDuckGo' })
    expect(engineNames(sources({ 'search.mode': 'web2', 'search.engine': 'brave' }))).toEqual({ web3: 'Explore', web2: 'Brave Search' })
  })

  it('leaves the Web2 name empty for an address that is none of the engines', () => {
    expect(engineNames(sources({ 'search.engine': 'custom', 'search.customUrl': 'https://s.example/?t=%s' })).web2).toBe('')
  })
})
