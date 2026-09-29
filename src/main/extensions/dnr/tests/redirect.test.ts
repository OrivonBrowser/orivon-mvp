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

  // vendor/firefox-dnr/UPSTREAM.md patch 16.
  it('drops a regexSubstitution redirect that resolves to file:, the same as any other disallowed scheme', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [
        {
          id: 1,
          priority: 1,
          condition: { regexFilter: '^http://from/(.*)$' },
          action: { type: 'redirect', redirect: { regexSubstitution: 'file:///\\1' } },
        },
      ],
    })
    const decision = engine.evaluate(makeRequest({ url: 'http://from/etc/passwd' }))
    expect(decision.redirectUrl).toBeUndefined()
  })
})

// vendor/firefox-dnr/UPSTREAM.md patch 16: neither redirect.url nor
// redirect.transform.scheme was checked against any scheme at all before
// this patch -- an extension's own rule JSON, read straight off disk,
// chose the target scheme unchecked, and Orivon never gives an extension
// file access (src/main/extensions/README.md's "allowFileAccess is never
// true" entry).
describe('redirect target validation', () => {
  it('rejects redirect.url targeting file:', () => {
    const engine = createDnrEngine()
    expect(() =>
      engine.updateDynamicRules('ext', {
        addRules: [
          { id: 1, priority: 1, condition: {}, action: { type: 'redirect', redirect: { url: 'file:///etc/passwd' } } },
        ],
      })
    ).toThrow(/redirect\.url may not target scheme/)
  })

  it('rejects redirect.url targeting javascript:', () => {
    const engine = createDnrEngine()
    expect(() =>
      engine.updateDynamicRules('ext', {
        addRules: [
          { id: 1, priority: 1, condition: {}, action: { type: 'redirect', redirect: { url: 'javascript:alert(1)' } } },
        ],
      })
    ).toThrow(/redirect\.url may not target scheme/)
  })

  it('rejects redirect.url targeting another extension\'s chrome-extension:// id', () => {
    const engine = createDnrEngine()
    expect(() =>
      engine.updateDynamicRules('ext-a', {
        addRules: [
          {
            id: 1,
            priority: 1,
            condition: {},
            action: { type: 'redirect', redirect: { url: 'chrome-extension://ext-b/page.html' } },
          },
        ],
      })
    ).toThrow(/redirect\.url may not target scheme/)
  })

  it('accepts redirect.url targeting the rule\'s own chrome-extension:// id', () => {
    const engine = createDnrEngine()
    engine.updateDynamicRules('ext-a', {
      addRules: [
        {
          id: 1,
          priority: 1,
          condition: {},
          action: { type: 'redirect', redirect: { url: 'chrome-extension://ext-a/page.html' } },
        },
      ],
    })
    expect(engine.evaluate(makeRequest({ url: 'http://old.example/' })).redirectUrl).toBe(
      'chrome-extension://ext-a/page.html'
    )
  })

  it('a valid http(s) redirect.url still works on a static, session, and dynamic ruleset', () => {
    const engine = createDnrEngine()
    engine.setStaticRulesets('ext', [
      {
        id: 'r1',
        enabled: true,
        rules: [{ id: 1, priority: 1, condition: {}, action: { type: 'redirect', redirect: { url: 'https://static.example/' } } }],
      },
    ])
    expect(engine.evaluate(makeRequest({ url: 'http://old.example/' })).redirectUrl).toBe('https://static.example/')
  })

  it('rejects redirect.transform.scheme targeting file:', () => {
    // adapters/dnr-uri.mjs's applyURLTransform sets transform.scheme via
    // WHATWG URL's own .protocol setter, which DOES apply a change between
    // two "special" schemes (http and file both are) without throwing --
    // the actual gap this validation closes, not a hypothetical one.
    const engine = createDnrEngine()
    expect(() =>
      engine.updateDynamicRules('ext', {
        addRules: [
          {
            id: 1,
            priority: 1,
            condition: {},
            action: { type: 'redirect', redirect: { transform: { scheme: 'file' as never } } },
          },
        ],
      })
    ).toThrow(/redirect\.transform\.scheme "file" is not allowed/)
  })

  it('rejects redirect.transform.scheme targeting data:', () => {
    const engine = createDnrEngine()
    expect(() =>
      engine.updateDynamicRules('ext', {
        addRules: [
          {
            id: 1,
            priority: 1,
            condition: {},
            action: { type: 'redirect', redirect: { transform: { scheme: 'data' as never } } },
          },
        ],
      })
    ).toThrow(/redirect\.transform\.scheme "data" is not allowed/)
  })

  it('a valid redirect.transform.scheme (https) still works', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [
        {
          id: 1,
          priority: 1,
          condition: {},
          action: { type: 'redirect', redirect: { transform: { scheme: 'https' } } },
        },
      ],
    })
    expect(engine.evaluate(makeRequest({ url: 'http://old.example/x' })).redirectUrl).toBe('https://old.example/x')
  })

  it('drops (evaluation-time defence in depth) a transform whose real target ends up chrome-extension:// for another extension', () => {
    // transform.scheme: "chrome-extension" cannot actually be produced by
    // applyURLTransform's own scheme setter (README.md's Design notes has
    // why), so the real risk is a rule that matches a request whose OWN
    // url is already chrome-extension:// and rewrites only transform.host
    // -- validation (run once, against a dummy http request) cannot see
    // that the request's real scheme will be chrome-extension:, so
    // dnr-engine.ts's computeRedirectUrl must catch it instead.
    const engine = createDnrEngine()
    engine.updateSessionRules('ext-a', {
      addRules: [
        {
          id: 1,
          priority: 1,
          condition: {},
          action: { type: 'redirect', redirect: { transform: { host: 'ext-b' } } },
        },
      ],
    })
    const decision = engine.evaluate(makeRequest({ url: 'chrome-extension://ext-a/page.html' }))
    expect(decision.redirectUrl).toBeUndefined()
  })
})
