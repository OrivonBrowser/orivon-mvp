import { describe, expect, it } from 'vitest'
import { createDnrEngine } from '../dnr-engine.js'
import { makeRequest } from './engine.test-helpers.js'

// redirect.url / .extensionPath / .transform / .regexSubstitution
// (test_ext_dnr_redirect_transform.js, test_ext_dnr_regexFilter.js's
// regexSubstitution_valid task).
describe('redirect.url', () => {
  it('redirects to the literal URL', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [
        { id: 1, priority: 1, condition: {}, action: { type: 'redirect', redirect: { url: 'https://new.example/' } } },
      ],
    })
    expect(engine.evaluate(makeRequest({ url: 'http://old.example/' })).redirectUrl).toBe('https://new.example/')
  })
})

describe('redirect.extensionPath', () => {
  it('resolves against the matching extension\'s own chrome-extension:// origin', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext-abc', {
      addRules: [
        { id: 1, priority: 1, condition: {}, action: { type: 'redirect', redirect: { extensionPath: '/blocked.html' } } },
      ],
    })
    expect(engine.evaluate(makeRequest({ url: 'http://old.example/' })).redirectUrl).toBe(
      'chrome-extension://ext-abc/blocked.html'
    )
  })
})

describe('redirect.transform', () => {
  it('rewrites scheme, host, path, and query', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [
        {
          id: 1,
          priority: 1,
          condition: {},
          action: {
            type: 'redirect',
            redirect: { transform: { scheme: 'https', host: 'new.example', path: '/x', query: '?a=1' } },
          },
        },
      ],
    })
    const decision = engine.evaluate(makeRequest({ url: 'http://old.example/y?b=2' }))
    expect(decision.redirectUrl).toBe('https://new.example/x?a=1')
  })

  it('applies queryTransform addOrReplaceParams and removeParams', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [
        {
          id: 1,
          priority: 1,
          condition: {},
          action: {
            type: 'redirect',
            redirect: {
              transform: {
                queryTransform: {
                  removeParams: ['drop'],
                  addOrReplaceParams: [{ key: 'added', value: 'v' }],
                },
              },
            },
          },
        },
      ],
    })
    const decision = engine.evaluate(makeRequest({ url: 'http://old.example/?keep=1&drop=2' }))
    expect(decision.redirectUrl).toBe('http://old.example/?keep=1&added=v')
  })
})

describe('redirect.regexSubstitution', () => {
  it('substitutes captured groups from the regexFilter match', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [
        {
          id: 1,
          priority: 1,
          condition: { regexFilter: '^http://from/(.*)$' },
          action: { type: 'redirect', redirect: { regexSubstitution: 'http://to/\\1' } },
        },
      ],
    })
    expect(engine.evaluate(makeRequest({ url: 'http://from/path?q=1' })).redirectUrl).toBe('http://to/path?q=1')
  })
})

describe('redirect validation', () => {
  it('rejects a rule with more than one of url/extensionPath/transform/regexSubstitution', () => {
    const engine = createDnrEngine()
    expect(() =>
      engine.updateSessionRules('ext', {
        addRules: [
          {
            id: 1,
            priority: 1,
            condition: {},
            action: { type: 'redirect', redirect: { url: 'http://a/', extensionPath: '/b' } },
          },
        ],
      })
    ).toThrow(/mutually exclusive/)
  })

  it('rejects regexSubstitution without a regexFilter condition', () => {
    const engine = createDnrEngine()
    expect(() =>
      engine.updateSessionRules('ext', {
        addRules: [
          {
            id: 1,
            priority: 1,
            condition: { urlFilter: 'x' },
            action: { type: 'redirect', redirect: { regexSubstitution: 'http://to/\\1' } },
          },
        ],
      })
    ).toThrow(/regexSubstitution requires the regexFilter/)
  })

  it('drops (does not surface) a regexSubstitution redirect that resolves to a non-http(s) target', () => {
    // The rule itself validates fine at add time (regexSubstitution's
    // syntax, not its eventual target, is what RuleValidator can check);
    // the http(s) scheme allowlist is enforced when the redirect is
    // actually computed, in vendor/firefox-dnr/src/extension-dnr.mjs's
    // applyRegexSubstitution. A rejected target is treated as no redirect,
    // not a thrown error, so one bad rule cannot fail an unrelated request.
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [
        {
          id: 1,
          priority: 1,
          condition: { regexFilter: '^http://from/(.*)$' },
          action: { type: 'redirect', redirect: { regexSubstitution: 'javascript:\\1' } },
        },
      ],
    })
    const decision = engine.evaluate(makeRequest({ url: 'http://from/alert(1)' }))
    expect(decision.redirectUrl).toBeUndefined()
    expect(decision.matchedRules).toContainEqual({ extensionId: 'ext', rulesetId: '_session', ruleId: 1, actionType: 'redirect' })
  })
})
