import { describe, expect, it } from 'vitest'
import { createDnrEngine } from '../dnr-engine.js'
import { makeRequest, blockRule } from './engine.test-helpers.js'

describe('getEnabledRulesets / getAvailableStaticRuleCount', () => {
  it('reports enabled ruleset ids in manifest order', () => {
    const engine = createDnrEngine()
    engine.setStaticRulesets('ext', [
      { id: 'a', enabled: true, rules: [] },
      { id: 'b', enabled: false, rules: [] },
      { id: 'c', enabled: true, rules: [] },
    ])
    expect(engine.getEnabledRulesets('ext')).toEqual(['a', 'c'])
  })

  it('is empty for an extension with no rulesets', () => {
    const engine = createDnrEngine()
    expect(engine.getEnabledRulesets('ext')).toEqual([])
  })

  it('shrinks the available static rule count as rules are added', () => {
    const engine = createDnrEngine()
    const before = engine.getAvailableStaticRuleCount('ext')
    engine.setStaticRulesets('ext', [{ id: 'a', enabled: true, rules: [blockRule(1, { urlFilter: 'x' })] }])
    expect(engine.getAvailableStaticRuleCount('ext')).toBe(before - 1)
  })
})

describe('testMatch', () => {
  it('reports a rule that would match, scoped to one extension only', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext-a', { addRules: [blockRule(1, { urlFilter: 'x' })] })
    engine.updateSessionRules('ext-b', { addRules: [blockRule(1, { urlFilter: 'x' })] })
    const matched = engine.testMatch('ext-a', makeRequest({ url: 'http://x/' }))
    expect(matched).toEqual([{ extensionId: 'ext-a', rulesetId: '_session', ruleId: 1 }])
  })

  it('ignores this extension\'s own host-permission gate', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [{ id: 1, priority: 1, condition: { urlFilter: 'x' }, action: { type: 'redirect', redirect: { url: 'https://y/' } } }],
    })
    engine.setActionAccess('ext', { hasHostAccess: () => false, requiresHostAccessForAllActions: false })
    expect(engine.evaluate(makeRequest({ url: 'http://x/' })).redirectUrl).toBeUndefined()
    expect(engine.testMatch('ext', makeRequest({ url: 'http://x/' }))).toEqual([
      { extensionId: 'ext', rulesetId: '_session', ruleId: 1 },
    ])
  })

  it('is empty for an unknown extension', () => {
    const engine = createDnrEngine()
    expect(engine.testMatch('nope', makeRequest({ url: 'http://x/' }))).toEqual([])
  })
})
