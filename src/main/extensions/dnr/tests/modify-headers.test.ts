import { describe, expect, it } from 'vitest'
import { createDnrEngine } from '../dnr-engine.js'
import { makeRequest } from './engine.test-helpers.js'

// modifyHeaders ordering (test_ext_dnr_modifyHeaders.js): rules apply in
// compareRule() order (priority, then ruleset precedence, then rule id);
// once a header is set/removed it cannot be modified again except "append"
// from the *same* rule's own extension, matching Chrome's documented
// per-header, per-extension precedence.
describe('modifyHeaders ordering', () => {
  it('applies requestHeaders ops in rule precedence order', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [
        {
          id: 2,
          priority: 1,
          condition: {},
          action: { type: 'modifyHeaders', requestHeaders: [{ header: 'x-b', operation: 'set', value: 'b' }] },
        },
        {
          id: 1,
          priority: 1,
          condition: {},
          action: { type: 'modifyHeaders', requestHeaders: [{ header: 'x-a', operation: 'set', value: 'a' }] },
        },
      ],
    })
    const decision = engine.evaluate(makeRequest({ url: 'http://example.com/' }))
    // Rule 1 (lower id, same priority/ruleset) is applied first.
    expect(decision.requestHeaders).toEqual([
      { header: 'x-a', operation: 'set', value: 'a' },
      { header: 'x-b', operation: 'set', value: 'b' },
    ])
  })

  it('a later rule cannot "set" a header a same-or-earlier rule already set', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [
        {
          id: 1,
          priority: 1,
          condition: {},
          action: { type: 'modifyHeaders', requestHeaders: [{ header: 'x-h', operation: 'set', value: 'first' }] },
        },
        {
          id: 2,
          priority: 1,
          condition: {},
          action: { type: 'modifyHeaders', requestHeaders: [{ header: 'x-h', operation: 'set', value: 'second' }] },
        },
      ],
    })
    const decision = engine.evaluate(makeRequest({ url: 'http://example.com/' }))
    expect(decision.requestHeaders).toEqual([{ header: 'x-h', operation: 'set', value: 'first' }])
  })

  it('"append" from the same extension is allowed after that extension\'s own "set"', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [
        {
          id: 1,
          priority: 1,
          condition: {},
          action: { type: 'modifyHeaders', requestHeaders: [{ header: 'x-h', operation: 'set', value: 'first' }] },
        },
        {
          id: 2,
          priority: 1,
          condition: {},
          action: { type: 'modifyHeaders', requestHeaders: [{ header: 'x-h', operation: 'append', value: 'second' }] },
        },
      ],
    })
    const decision = engine.evaluate(makeRequest({ url: 'http://example.com/' }))
    expect(decision.requestHeaders).toEqual([
      { header: 'x-h', operation: 'set', value: 'first' },
      { header: 'x-h', operation: 'append', value: 'second' },
    ])
  })

  it('"append" from a different extension after another extension\'s "set" is rejected', () => {
    // Cross-extension order is most-recently-registered-first, so the
    // extension registered second is the one whose op is applied first.
    const engine = createDnrEngine()
    engine.updateSessionRules('ext-older', {
      addRules: [
        {
          id: 1,
          priority: 1,
          condition: {},
          action: { type: 'modifyHeaders', requestHeaders: [{ header: 'x-h', operation: 'append', value: 'b' }] },
        },
      ],
    })
    engine.updateSessionRules('ext-newer', {
      addRules: [
        {
          id: 1,
          priority: 1,
          condition: {},
          action: { type: 'modifyHeaders', requestHeaders: [{ header: 'x-h', operation: 'set', value: 'a' }] },
        },
      ],
    })
    const decision = engine.evaluate(makeRequest({ url: 'http://example.com/' }))
    // ext-newer's "set" runs first and wins the header; ext-older's later
    // "append" is rejected because it belongs to a different extension.
    expect(decision.requestHeaders).toEqual([{ header: 'x-h', operation: 'set', value: 'a' }])
  })

  it('"remove" is final: no later rule can set/append/remove that header again', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [
        {
          id: 1,
          priority: 1,
          condition: {},
          action: { type: 'modifyHeaders', requestHeaders: [{ header: 'x-h', operation: 'remove' }] },
        },
        {
          id: 2,
          priority: 1,
          condition: {},
          action: { type: 'modifyHeaders', requestHeaders: [{ header: 'x-h', operation: 'append', value: 'late' }] },
        },
      ],
    })
    const decision = engine.evaluate(makeRequest({ url: 'http://example.com/' }))
    expect(decision.requestHeaders).toEqual([{ header: 'x-h', operation: 'remove', value: '' }])
  })

  it('requestHeaders and responseHeaders are tracked independently', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [
        {
          id: 1,
          priority: 1,
          condition: {},
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'x-req', operation: 'set', value: 'req' }],
            responseHeaders: [{ header: 'x-res', operation: 'set', value: 'res' }],
          },
        },
      ],
    })
    const decision = engine.evaluate(makeRequest({ url: 'http://example.com/' }))
    expect(decision.requestHeaders).toEqual([{ header: 'x-req', operation: 'set', value: 'req' }])
    expect(decision.responseHeaders).toEqual([{ header: 'x-res', operation: 'set', value: 'res' }])
  })

  it('rejects a requestHeaders op that "set"s the Host header', () => {
    // vendor/firefox-dnr/UPSTREAM.md patch 17: restores Firefox's own
    // #checkHostHeader refusal, dropped by patch 6, as a flat
    // validation-time rejection.
    const engine = createDnrEngine()
    expect(() =>
      engine.updateDynamicRules('ext', {
        addRules: [
          {
            id: 1,
            priority: 1,
            condition: {},
            action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Host', operation: 'set', value: 'evil.example' }] },
          },
        ],
      })
    ).toThrow(/Host header/)
  })

  it('rejects "append" and "remove" ops on the Host header too, case-insensitively', () => {
    const engine = createDnrEngine()
    expect(() =>
      engine.updateDynamicRules('ext', {
        addRules: [
          {
            id: 1,
            priority: 1,
            condition: {},
            action: { type: 'modifyHeaders', requestHeaders: [{ header: 'HOST', operation: 'append', value: 'evil.example' }] },
          },
        ],
      })
    ).toThrow(/Host header/)
    expect(() =>
      engine.updateDynamicRules('ext', {
        addRules: [
          { id: 2, priority: 1, condition: {}, action: { type: 'modifyHeaders', requestHeaders: [{ header: 'host', operation: 'remove' }] } },
        ],
      })
    ).toThrow(/Host header/)
  })

  it('a responseHeaders op naming "host" is unaffected: Host is a request-only header', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [
        {
          id: 1,
          priority: 1,
          condition: {},
          action: { type: 'modifyHeaders', responseHeaders: [{ header: 'host', operation: 'set', value: 'x' }] },
        },
      ],
    })
    const decision = engine.evaluate(makeRequest({ url: 'http://example.com/' }))
    expect(decision.responseHeaders).toEqual([{ header: 'host', operation: 'set', value: 'x' }])
  })

  it('non-Host headers Chrome does not restrict (Cookie, Referer, Origin) are still allowed', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [
        {
          id: 1,
          priority: 1,
          condition: {},
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'Cookie', operation: 'set', value: 'a=b' },
              { header: 'Referer', operation: 'set', value: 'https://r.example/' },
              { header: 'Origin', operation: 'set', value: 'https://o.example' },
            ],
          },
        },
      ],
    })
    const decision = engine.evaluate(makeRequest({ url: 'http://example.com/' }))
    expect(decision.requestHeaders).toHaveLength(3)
  })

  it('modifyHeaders rules at or below an allow rule\'s priority are dropped', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [
        { id: 1, priority: 2, condition: {}, action: { type: 'allow' } },
        {
          id: 2,
          priority: 1,
          condition: {},
          action: { type: 'modifyHeaders', requestHeaders: [{ header: 'x-h', operation: 'set', value: 'v' }] },
        },
      ],
    })
    const decision = engine.evaluate(makeRequest({ url: 'http://example.com/' }))
    expect(decision.requestHeaders).toBeUndefined()
  })
})
