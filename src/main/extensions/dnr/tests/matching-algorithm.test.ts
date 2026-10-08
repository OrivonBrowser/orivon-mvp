import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createDnrEngine } from '../dnr-engine.js'
import { makeRequest, nextId } from './engine.test-helpers.js'

function loadFixture<T>(name: string): T {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/** Adds one urlFilter session rule and reports whether `url` matched it. */
function urlFilterMatches(url: string, urlFilter: string, isUrlFilterCaseSensitive?: boolean): boolean {
  const engine = createDnrEngine()
  const id = nextId()
  const condition = isUrlFilterCaseSensitive === undefined ? { urlFilter } : { urlFilter, isUrlFilterCaseSensitive }
  engine.updateSessionRules('ext-matching-algorithm', {
    addRules: [{ id, priority: 1, condition, action: { type: 'block' } }],
  })
  const decision = engine.evaluate(makeRequest({ url }))
  return decision.cancel === true
}

// Chrome's own #matching-algorithm test table, as ported into Firefox's
// test_ext_dnr_urlFilter.js (test_chrome_parity, mined into this fixture --
// see this directory's README section Design notes for how). Each case names the
// urlFilter construct it targets (kBoundary = "|", kSubdomain = "||",
// URL_PATTERN_TYPE_SUBSTRING = a plain substring, etc.) in Chrome's own
// source comments, dropped here since the vectors speak for themselves.
describe('urlFilter matching, Chrome parity table (developer.chrome.com #matching-algorithm)', () => {
  const vectors = loadFixture<
    Array<{
      urlFilter: string
      url: string
      isUrlFilterCaseSensitive?: boolean
      expectMatch: boolean
    }>
  >('chrome-parity-urlfilter-vectors.json')

  it.each(
    vectors.map(v => [v.urlFilter, v.url, v.isUrlFilterCaseSensitive, v.expectMatch] as const)
  )('urlFilter %j against %j (case-sensitive=%s) -> match=%s', (urlFilter, url, isUrlFilterCaseSensitive, expectMatch) => {
    expect(urlFilterMatches(url, urlFilter, isUrlFilterCaseSensitive)).toBe(expectMatch)
  })
})

// Firefox's own ambiguous-pattern coverage (anchors combined with wildcards,
// domain-anchor edge cases): test_ext_dnr_urlFilter.js's
// ambiguous_urlFilter_patterns and urlFilter_domain_anchor tasks.
describe('urlFilter matching, ambiguous anchor/wildcard combinations', () => {
  const vectors = loadFixture<
    Array<{
      urlFilter: string
      isUrlFilterCaseSensitive?: boolean
      urls?: string[]
      urlsNonMatching?: string[]
    }>
  >('ambiguous-urlfilter-vectors.json')

  for (const vector of vectors) {
    for (const url of vector.urls ?? []) {
      it(`urlFilter ${JSON.stringify(vector.urlFilter)} matches ${url}`, () => {
        expect(urlFilterMatches(url, vector.urlFilter, vector.isUrlFilterCaseSensitive)).toBe(true)
      })
    }
    for (const url of vector.urlsNonMatching ?? []) {
      it(`urlFilter ${JSON.stringify(vector.urlFilter)} does not match ${url}`, () => {
        expect(urlFilterMatches(url, vector.urlFilter, vector.isUrlFilterCaseSensitive)).toBe(false)
      })
    }
  }
})

// Representative regexFilter cases (test_ext_dnr_regexFilter.js's
// regexFilter_basic / regexFilter_more_than_basic / _isUrlFilterCaseSensitive
// tasks): groups, quantifiers, alternation, anchors, character classes, and
// case sensitivity, all evaluated against RegExp.prototype.test unmodified,
// so this is really a check that regexFilter reaches RegExp unaltered.
describe('regexFilter matching', () => {
  function regexFilterMatches(url: string, regexFilter: string, isUrlFilterCaseSensitive?: boolean): boolean {
    const engine = createDnrEngine()
    const id = nextId()
    const condition =
      isUrlFilterCaseSensitive === undefined ? { regexFilter } : { regexFilter, isUrlFilterCaseSensitive }
    engine.updateSessionRules('ext-regex', {
      addRules: [{ id, priority: 1, condition, action: { type: 'block' } }],
    })
    return engine.evaluate(makeRequest({ url })).cancel === true
  }

  it.each([
    ['http://example.com/', 'http://example.com/', true],
    ['http://from/[a-b]', 'http://from/a', true],
    ['http://from/[a-b]', 'http://from/c', false],
    ['http://from/(a)', 'http://from/a', true],
    ['a+b*c?d', 'http://x/aaabbd', true],
    ['a.*b', 'http://x/a123b', true],
    ['^http://from/', 'http://from/x', true],
    ['^http://from/', 'http://notfrom/x', false],
    ['http://from/$', 'http://from/', true],
    ['http://from/a{2,3}b', 'http://from/aaab', true],
    ['http://from/a{2,3}b', 'http://from/ab', false],
    ['from/a|from/b$|c$', 'http://x/from/a', true],
    ['http://from/[^a-z]', 'http://from/1', true],
    ['http://from/[^a-z]', 'http://from/a', false],
    ['http://from/\\w', 'http://from/_', true],
  ] as const)('regexFilter %j against %j -> match=%s', (regexFilter, url, expectMatch) => {
    expect(regexFilterMatches(url, regexFilter)).toBe(expectMatch)
  })

  it('is case-insensitive by default', () => {
    expect(regexFilterMatches('http://x/FROM/Pa', 'from/pa')).toBe(true)
  })

  it('is case-sensitive when isUrlFilterCaseSensitive is set', () => {
    expect(regexFilterMatches('http://x/FROM/Pa', 'from/pa', true)).toBe(false)
    expect(regexFilterMatches('http://x/from/pa', 'from/pa', true)).toBe(true)
  })
})
