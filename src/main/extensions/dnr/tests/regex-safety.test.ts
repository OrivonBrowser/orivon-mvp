import { describe, expect, it } from 'vitest'
import { regexFilterProblem } from '../../../../../vendor/firefox-dnr/adapters/dnr-regex-safety.mjs'
import { createDnrEngine } from '../dnr-engine.js'
import { blockRule, makeRequest } from './engine.test-helpers.js'

const NESTED = '(?:[a-z0-9/._-]+)+\\x01'
const NESTED_ANCHORED = '^(a+)+$'
const BACKTRACKING = [
  NESTED,
  NESTED_ANCHORED,
  '(a*)*b',
  '^(.*)*x',
  '(a|a)+$',
  '(a|ab)*c',
  '^(\\w+\\s?)+$',
  '(?:[^/]+\\.)*example\\.com',
  '(a{1,2})*x',
  '(.*)a(.*)b(.*)c',
  '.*.*.*x',
]

const SUFFIX_RULE = '^https?://[^/]*\\.example\\.com/.*\\.js'
const ORDINARY = [
  '^http://from/(.*)$',
  '^https?:\\/\\/(?:[a-z0-9-]+\\.)*example\\.com\\/',
  '^https?:\\/\\/(?:[^/]+\\.)?example\\.com\\/',
  SUFFIX_RULE,
  '^https?:\\/\\/[0-9a-z]{8,}\\.com\\/[a-z]{6}\\.js$',
  '(?:\\/[^\\/]+)*\\/ads',
  '\\/ads?\\/.*\\.(?:gif|png|jpe?g)',
  '[?&]utm_[a-z]+=',
  '^https://(?:www\\.)?(?:track|pixel)\\.[a-z]+\\.(?:com|net)/',
  'from/pa',
]

describe('regexFilter safety', () => {
  it.each(BACKTRACKING)('refuses %j', pattern => {
    expect(regexFilterProblem(pattern)?.kind).toBe('complexity')
  })

  it.each(ORDINARY)('keeps %j', pattern => {
    expect(regexFilterProblem(pattern)).toBeNull()
  })

  it('refuses a pattern over 2048 characters and keeps one at the limit', () => {
    expect(regexFilterProblem('a'.repeat(2049))?.kind).toBe('complexity')
    expect(regexFilterProblem('a'.repeat(2048))).toBeNull()
  })

  it.each(['(a)\\1', '(?=a)b', '(?!a)b', '(?<=a)b', '(?<!a)b', '(?<n>a)\\k<n>'])(
    'refuses %j, which RE2 does not have',
    pattern => {
      expect(regexFilterProblem(pattern)?.kind).toBe('syntax')
    }
  )

  it('refuses a catastrophic rule in a dynamic and a session rule update, and keeps the ordinary ones', () => {
    const engine = createDnrEngine()
    expect(() =>
      engine.updateDynamicRules('ext', { addRules: [blockRule(1, { regexFilter: NESTED })] })
    ).toThrow(/regexFilter/)
    expect(() =>
      engine.updateSessionRules('ext', { addRules: [blockRule(2, { regexFilter: NESTED_ANCHORED })] })
    ).toThrow(/regexFilter/)
    engine.updateDynamicRules('ext', { addRules: [blockRule(3, { regexFilter: SUFFIX_RULE })] })
    expect(engine.evaluate(makeRequest({ url: 'https://a.example.com/x/y.js' })).cancel).toBe(true)
    expect(engine.evaluate(makeRequest({ url: 'https://other.test/x/y.js' })).cancel).toBeFalsy()
  })

  it('loads the rest of a static ruleset when one of its rules is refused', () => {
    const engine = createDnrEngine()
    engine.setStaticRulesets('ext', [
      {
        id: 'r',
        enabled: true,
        rules: [blockRule(1, { regexFilter: '(a|a)+$' }), blockRule(2, { regexFilter: SUFFIX_RULE })],
      },
    ])
    expect(engine.evaluate(makeRequest({ url: 'https://a.example.com/x.js' })).cancel).toBe(true)
    expect(engine.evaluate(makeRequest({ url: 'https://other.test/a' })).cancel).toBeFalsy()
  })

  it('answers a long URL the ordinary rules do not match without delay', () => {
    const engine = createDnrEngine()
    engine.updateDynamicRules('ext', {
      addRules: ORDINARY.map((regexFilter, i) => blockRule(i + 1, { regexFilter })),
    })
    const url = `https://host.test/${'a1/'.repeat(600)}?${'x=1&'.repeat(200)}`
    const started = Date.now()
    engine.evaluate(makeRequest({ url }))
    expect(Date.now() - started).toBeLessThan(500)
  })
})
