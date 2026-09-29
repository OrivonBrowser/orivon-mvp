import { describe, expect, it } from 'vitest'
import { createDnrEngine } from '../dnr-engine.js'
import { makeRequest, blockRule } from './engine.test-helpers.js'

describe('updateDynamicRules', () => {
  it('adds, then removes, a dynamic rule', () => {
    const engine = createDnrEngine()
    engine.updateDynamicRules('ext', { addRules: [blockRule(1, {})] })
    expect(engine.evaluate(makeRequest({ url: 'http://x/' })).cancel).toBe(true)
    engine.updateDynamicRules('ext', { removeRuleIds: [1] })
    expect(engine.evaluate(makeRequest({ url: 'http://x/' })).cancel).toBeUndefined()
  })

  it('getDynamicRules returns plain data, defaulting an omitted priority to 1', () => {
    const engine = createDnrEngine()
    engine.updateDynamicRules('ext', {
      addRules: [{ id: 1, condition: { urlFilter: 'x' }, action: { type: 'block' } }],
    })
    expect(engine.getDynamicRules('ext')).toEqual([
      { id: 1, priority: 1, condition: { urlFilter: 'x' }, action: { type: 'block' } },
    ])
  })

  it('rejects a duplicate rule id', () => {
    const engine = createDnrEngine()
    engine.updateDynamicRules('ext', { addRules: [blockRule(1, {})] })
    expect(() => engine.updateDynamicRules('ext', { addRules: [blockRule(1, {})] })).toThrow(/Duplicate rule ID/)
  })

  it('rejects tabIds on a dynamic rule (session rules only)', () => {
    const engine = createDnrEngine()
    expect(() =>
      engine.updateDynamicRules('ext', {
        addRules: [{ id: 1, priority: 1, condition: { tabIds: [1] }, action: { type: 'block' } }],
      })
    ).toThrow(/tabIds and excludedTabIds can only be specified in session rules/)
  })

  it('rejects more than MAX_NUMBER_OF_DYNAMIC_RULES rules', () => {
    const engine = createDnrEngine()
    const rules = Array.from({ length: 30001 }, (_, i) => blockRule(i + 1, { urlFilter: `x${i}` }))
    expect(() => engine.updateDynamicRules('ext', { addRules: rules })).toThrow(/exceeds MAX_NUMBER_OF_DYNAMIC_RULES/)
  })

  it('rejects more than MAX_NUMBER_OF_REGEX_RULES regex rules', () => {
    const engine = createDnrEngine()
    const rules = Array.from({ length: 1001 }, (_, i) => blockRule(i + 1, { regexFilter: `x${i}` }))
    expect(() => engine.updateDynamicRules('ext', { addRules: rules })).toThrow(/exceeds MAX_NUMBER_OF_REGEX_RULES/)
  })
})

describe('updateSessionRules', () => {
  it('allows tabIds and restricts matching to the listed tab', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [{ id: 1, priority: 1, condition: { tabIds: [7] }, action: { type: 'block' } }],
    })
    expect(engine.evaluate(makeRequest({ url: 'http://x/', tabId: 7 })).cancel).toBe(true)
    expect(engine.evaluate(makeRequest({ url: 'http://x/', tabId: 8 })).cancel).toBeUndefined()
  })

  it('rejects more than MAX_NUMBER_OF_SESSION_RULES rules', () => {
    const engine = createDnrEngine()
    const rules = Array.from({ length: 5001 }, (_, i) => blockRule(i + 1, { urlFilter: `x${i}` }))
    expect(() => engine.updateSessionRules('ext', { addRules: rules })).toThrow(/exceeds MAX_NUMBER_OF_SESSION_RULES/)
  })
})

describe('setStaticRulesets / updateEnabledRulesets', () => {
  it('only enabled rulesets take part in matching', () => {
    const engine = createDnrEngine()
    engine.setStaticRulesets('ext', [
      { id: 'on', enabled: true, rules: [blockRule(1, { urlFilter: 'on' })] },
      { id: 'off', enabled: false, rules: [blockRule(1, { urlFilter: 'off' })] },
    ])
    expect(engine.evaluate(makeRequest({ url: 'http://x/on' })).cancel).toBe(true)
    expect(engine.evaluate(makeRequest({ url: 'http://x/off' })).cancel).toBeUndefined()
  })

  it('updateEnabledRulesets flips a ruleset on without re-supplying its rules', () => {
    const engine = createDnrEngine()
    engine.setStaticRulesets('ext', [{ id: 'off', enabled: false, rules: [blockRule(1, { urlFilter: 'off' })] }])
    expect(engine.evaluate(makeRequest({ url: 'http://x/off' })).cancel).toBeUndefined()
    engine.updateEnabledRulesets('ext', { enableRulesetIds: ['off'] })
    expect(engine.evaluate(makeRequest({ url: 'http://x/off' })).cancel).toBe(true)
    engine.updateEnabledRulesets('ext', { disableRulesetIds: ['off'] })
    expect(engine.evaluate(makeRequest({ url: 'http://x/off' })).cancel).toBeUndefined()
  })

  it('rejects an unknown ruleset id', () => {
    const engine = createDnrEngine()
    engine.setStaticRulesets('ext', [{ id: 'a', enabled: true, rules: [] }])
    expect(() => engine.updateEnabledRulesets('ext', { enableRulesetIds: ['nope'] })).toThrow(/Invalid ruleset id/)
  })

  it('rejects more than MAX_NUMBER_OF_ENABLED_STATIC_RULESETS enabled at once', () => {
    const engine = createDnrEngine()
    const rulesets = Array.from({ length: 51 }, (_, i) => ({ id: `r${i}`, enabled: true, rules: [] }))
    expect(() => engine.setStaticRulesets('ext', rulesets)).toThrow(/MAX_NUMBER_OF_ENABLED_STATIC_RULESETS/)
  })

  it('rejects a duplicate static ruleset id', () => {
    const engine = createDnrEngine()
    expect(() =>
      engine.setStaticRulesets('ext', [
        { id: 'dup', enabled: true, rules: [] },
        { id: 'dup', enabled: true, rules: [] },
      ])
    ).toThrow(/Duplicate static ruleset id/)
  })

  it('rejects the static rule count across enabled rulesets exceeding GUARANTEED_MINIMUM_STATIC_RULES', () => {
    const engine = createDnrEngine()
    const rules = Array.from({ length: 30001 }, (_, i) => blockRule(i + 1, { urlFilter: `x${i}` }))
    expect(() => engine.setStaticRulesets('ext', [{ id: 'r', enabled: true, rules }])).toThrow(
      /GUARANTEED_MINIMUM_STATIC_RULES/
    )
  })
})

describe('removeExtension', () => {
  it('clears both dynamic/session rules and the static ruleset bookkeeping', () => {
    const engine = createDnrEngine()
    engine.updateDynamicRules('ext', { addRules: [blockRule(1, {})] })
    engine.setStaticRulesets('ext', [{ id: 'r', enabled: true, rules: [blockRule(2, { urlFilter: 'r' })] }])
    engine.removeExtension('ext')
    expect(engine.getDynamicRules('ext')).toEqual([])
    expect(engine.evaluate(makeRequest({ url: 'http://x/r' })).cancel).toBeUndefined()
    // Re-adding after removal starts from a clean slate (no leftover "Duplicate rule ID").
    engine.updateDynamicRules('ext', { addRules: [blockRule(1, {})] })
    expect(engine.evaluate(makeRequest({ url: 'http://x/' })).cancel).toBe(true)
  })
})

describe('independent engine instances', () => {
  it('rules added to one engine are invisible to another', () => {
    const engineA = createDnrEngine()
    const engineB = createDnrEngine()
    engineA.updateSessionRules('ext', { addRules: [blockRule(1, {})] })
    expect(engineA.evaluate(makeRequest({ url: 'http://x/' })).cancel).toBe(true)
    expect(engineB.evaluate(makeRequest({ url: 'http://x/' })).cancel).toBeUndefined()
  })
})
