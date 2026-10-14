import { describe, expect, it } from 'vitest'
import { compileRegexFilter, regexFilterProblem } from '../../../../../vendor/firefox-dnr/adapters/dnr-regex.mjs'
import { createDnrEngine } from '../dnr-engine.js'
import { blockRule, makeRequest } from './engine.test-helpers.js'

// Patterns a backtracking engine runs in exponential or high-degree
// polynomial time. RE2 runs every one in time linear in the URL.
const HOSTILE = [
  '(?:[a-z0-9/._-]+)+\\x01',
  '^(a+)+$',
  '(a|a)*$',
  '(a*)*b',
  '.*a.*b',
  'a.*a.*b',
  '\\d+\\d+x',
  '[a-z]+[a-z0-9]+!',
  '(.*)a(.*)b(.*)c',
]

const ORDINARY: ReadonlyArray<readonly [pattern: string, url: string, matches: boolean]> = [
  ['^https?:\\/\\/(?:[a-z0-9-]+\\.)*example\\.com\\/', 'https://a.b.example.com/x', true],
  ['^https?:\\/\\/(?:[a-z0-9-]+\\.)*example\\.com\\/', 'https://example.org/x', false],
  ['^https?://[^/]*\\.example\\.com/.*\\.js', 'https://cdn.example.com/a/b.js', true],
  ['^https?:\\/\\/[0-9a-z]{8,}\\.com\\/[a-z]{6}\\.js$', 'https://abcdefgh1.com/abcdef.js', true],
  ['\\/ads?\\/.*\\.(?:gif|png|jpe?g)', 'https://x.test/ad/a.JPEG', true],
  ['\\/ads?\\/.*\\.(?:gif|png|jpe?g)', 'https://x.test/ad/a.txt', false],
  ['[?&]utm_[a-z]+=', 'https://x.test/p?q=1&utm_source=z', true],
]

const URL_OF = (n: number): string => `https://host.test/${'a'.repeat(n)}`

describe('regexFilter is matched by RE2, in linear time', () => {
  it.each(HOSTILE)('answers %j on a 100,000-character URL within a tight budget', pattern => {
    expect(regexFilterProblem(pattern, true)).toBeNull()
    const compiled = compileRegexFilter(pattern, true)
    const started = Date.now()
    compiled.test(URL_OF(100_000))
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it.each(ORDINARY)('matches %j against %j -> %s', (pattern, url, expected) => {
    expect(compileRegexFilter(pattern, false).test(url)).toBe(expected)
  })

  it('follows isUrlFilterCaseSensitive', () => {
    expect(compileRegexFilter('from/pa', false).test('http://x/FROM/Pa')).toBe(true)
    expect(compileRegexFilter('from/pa', true).test('http://x/FROM/Pa')).toBe(false)
  })

  it('exec returns the whole match then each group, undefined for one that did not take part', () => {
    const exec = compileRegexFilter('^http://from/(a)?(b)(c)?', true).exec('http://from/bz')
    expect(exec).toEqual(['http://from/b', undefined, 'b', undefined])
    expect(compileRegexFilter('x', true).exec('y')).toBeNull()
  })

  it('refuses a pattern over 2048 characters and keeps one at the limit', () => {
    expect(regexFilterProblem('a'.repeat(2049), true)?.kind).toBe('complexity')
    expect(regexFilterProblem('a'.repeat(2048), true)).toBeNull()
  })

  it.each(['(a)\\1', '(?=a)b', '(?!a)b', '(?<=a)b', '(?<!a)b', '(unclosed'])('refuses %j, which RE2 does not accept', pattern => {
    expect(regexFilterProblem(pattern, true)?.kind).toBe('syntax')
  })
})

describe('regexFilter in the engine', () => {
  it('refuses an unsupported pattern when a rule is added, and keeps ordinary ones', () => {
    const engine = createDnrEngine()
    expect(() => engine.updateDynamicRules('ext', { addRules: [blockRule(1, { regexFilter: '(a)\\1' })] })).toThrow(/regexFilter/)
    expect(() => engine.updateSessionRules('ext', { addRules: [blockRule(2, { regexFilter: '(?=a)b' })] })).toThrow(/regexFilter/)
    engine.updateDynamicRules('ext', { addRules: [blockRule(3, { regexFilter: ORDINARY[2]![0] })] })
    expect(engine.evaluate(makeRequest({ url: 'https://a.example.com/x/y.js' })).cancel).toBe(true)
    expect(engine.evaluate(makeRequest({ url: 'https://other.test/x/y.js' })).cancel).toBeFalsy()
  })

  it('loads the rest of a static ruleset when one of its rules is refused', () => {
    const engine = createDnrEngine()
    engine.setStaticRulesets('ext', [
      { id: 'r', enabled: true, rules: [blockRule(1, { regexFilter: '(a)\\1' }), blockRule(2, { regexFilter: ORDINARY[2]![0] })] },
    ])
    expect(engine.evaluate(makeRequest({ url: 'https://a.example.com/x.js' })).cancel).toBe(true)
  })

  it('evaluates hostile-looking rules against a 100,000-character URL without delay', () => {
    const engine = createDnrEngine()
    engine.updateDynamicRules('ext', { addRules: HOSTILE.map((regexFilter, i) => blockRule(i + 1, { regexFilter })) })
    const started = Date.now()
    engine.evaluate(makeRequest({ url: URL_OF(100_000) }))
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('a regexSubstitution redirect still fills its groups', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [{
        id: 1,
        priority: 1,
        condition: { regexFilter: '^http://from/(.*)/(.*)$' },
        action: { type: 'redirect', redirect: { regexSubstitution: 'https://to.test/\\2/\\1?w=\\0' } },
      }],
    })
    const decision = engine.evaluate(makeRequest({ url: 'http://from/a/b' }))
    expect(decision.redirectUrl).toBe('https://to.test/b/a?w=http://from/a/b')
  })
})
