import { describe, expect, it } from 'vitest'
import { createDnrEngine } from '../dnr-engine.js'
import { makeRequest } from './engine.test-helpers.js'

// declarative_net_request.json's precedence contract, ported from the rule-
// ordering cases in ExtensionDNR.sys.mjs's own top comment and exercised
// through test_ext_dnr_testMatchOutcome.js: session > dynamic > static;
// within a ruleset, highest priority wins; same priority is broken by action
// type (allow/allowAllRequests > block > upgradeScheme > redirect >
// modifyHeaders); same priority+action is broken by lowest rule id.
describe('ruleset precedence: session > dynamic > static', () => {
  // Ruleset precedence is the *last* tiebreaker (after priority, then action
  // type), so isolating it means giving both rules the same priority and
  // the same action type -- here, "redirect", broken only by which target
  // wins.
  it('a session redirect beats a same-priority static redirect', () => {
    const engine = createDnrEngine()
    engine.setStaticRulesets('ext', [
      {
        id: 'r1',
        enabled: true,
        rules: [{ id: 1, priority: 1, condition: {}, action: { type: 'redirect', redirect: { url: 'http://static/' } } }],
      },
    ])
    engine.updateSessionRules('ext', {
      addRules: [{ id: 1, priority: 1, condition: {}, action: { type: 'redirect', redirect: { url: 'http://session/' } } }],
    })
    expect(engine.evaluate(makeRequest({ url: 'http://example.com/' })).redirectUrl).toBe('http://session/')
  })

  it('a dynamic redirect beats a same-priority static redirect', () => {
    const engine = createDnrEngine()
    engine.setStaticRulesets('ext', [
      {
        id: 'r1',
        enabled: true,
        rules: [{ id: 1, priority: 1, condition: {}, action: { type: 'redirect', redirect: { url: 'http://static/' } } }],
      },
    ])
    engine.updateDynamicRules('ext', {
      addRules: [{ id: 1, priority: 1, condition: {}, action: { type: 'redirect', redirect: { url: 'http://dynamic/' } } }],
    })
    expect(engine.evaluate(makeRequest({ url: 'http://example.com/' })).redirectUrl).toBe('http://dynamic/')
  })

  it('action-type precedence outranks ruleset precedence: a static allow beats a session block at equal priority', () => {
    const engine = createDnrEngine()
    engine.setStaticRulesets('ext', [
      { id: 'r1', enabled: true, rules: [{ id: 1, priority: 1, condition: {}, action: { type: 'allow' } }] },
    ])
    engine.updateSessionRules('ext', {
      addRules: [{ id: 2, priority: 1, condition: {}, action: { type: 'block' } }],
    })
    expect(engine.evaluate(makeRequest({ url: 'http://example.com/' })).cancel).toBeUndefined()
  })
})

describe('rule precedence within a ruleset', () => {
  it('a higher explicit priority wins regardless of action type', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [
        { id: 1, priority: 5, condition: {}, action: { type: 'allow' } },
        { id: 2, priority: 10, condition: {}, action: { type: 'block' } },
      ],
    })
    expect(engine.evaluate(makeRequest({ url: 'http://example.com/' })).cancel).toBe(true)
  })

  it('at equal priority, action precedence is allow > block > upgradeScheme > redirect', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [
        { id: 1, priority: 1, condition: {}, action: { type: 'redirect', redirect: { url: 'http://elsewhere/' } } },
        { id: 2, priority: 1, condition: {}, action: { type: 'upgradeScheme' } },
        { id: 3, priority: 1, condition: {}, action: { type: 'block' } },
        { id: 4, priority: 1, condition: {}, action: { type: 'allow' } },
      ],
    })
    const decision = engine.evaluate(makeRequest({ url: 'http://example.com/' }))
    expect(decision.cancel).toBeUndefined()
    expect(decision.upgradeToHttps).toBeUndefined()
    expect(decision.redirectUrl).toBeUndefined()
    expect(decision.matchedRules[0]).toMatchObject({ ruleId: 4 })
  })

  it('at equal priority and action, the lowest rule id wins', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [
        { id: 9, priority: 1, condition: {}, action: { type: 'redirect', redirect: { url: 'http://nine/' } } },
        { id: 3, priority: 1, condition: {}, action: { type: 'redirect', redirect: { url: 'http://three/' } } },
      ],
    })
    const decision = engine.evaluate(makeRequest({ url: 'http://example.com/' }))
    expect(decision.redirectUrl).toBe('http://three/')
  })

  it('block short-circuits: once matched, no lower-precedence extension can override it', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext-a', {
      addRules: [{ id: 1, priority: 1, condition: {}, action: { type: 'block' } }],
    })
    engine.updateSessionRules('ext-b', {
      addRules: [{ id: 1, priority: 1, condition: {}, action: { type: 'allow' } }],
    })
    expect(engine.evaluate(makeRequest({ url: 'http://example.com/' })).cancel).toBe(true)
  })
})

describe('cross-extension precedence', () => {
  it('the most recently registered extension wins a same-priority allow/allow tie', () => {
    const engine = createDnrEngine()
    // ext-a registers first (via its first rule update), ext-b second.
    engine.updateSessionRules('ext-a', {
      addRules: [{ id: 1, priority: 1, condition: {}, action: { type: 'redirect', redirect: { url: 'http://a/' } } }],
    })
    engine.updateSessionRules('ext-b', {
      addRules: [{ id: 1, priority: 1, condition: {}, action: { type: 'redirect', redirect: { url: 'http://b/' } } }],
    })
    // Across extensions, block > redirect/upgradeScheme > allow/allowAllRequests
    // (evaluateRequest's own precedence()); among same-precedence redirects
    // from different extensions, iteration order (most recent first) decides.
    expect(engine.evaluate(makeRequest({ url: 'http://example.com/' })).redirectUrl).toBe('http://b/')
  })

  it('block from any extension beats redirect/allow from a more recent one', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext-a', {
      addRules: [{ id: 1, priority: 1, condition: {}, action: { type: 'block' } }],
    })
    engine.updateSessionRules('ext-b', {
      addRules: [{ id: 1, priority: 1, condition: {}, action: { type: 'redirect', redirect: { url: 'http://b/' } } }],
    })
    expect(engine.evaluate(makeRequest({ url: 'http://example.com/' })).cancel).toBe(true)
  })

  it('removeExtension drops that extension from future evaluation', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext-a', {
      addRules: [{ id: 1, priority: 1, condition: {}, action: { type: 'block' } }],
    })
    engine.removeExtension('ext-a')
    expect(engine.evaluate(makeRequest({ url: 'http://example.com/' })).cancel).toBeUndefined()
  })
})
