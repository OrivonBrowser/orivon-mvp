import { describe, expect, it, vi } from 'vitest'
import { createDnrEngine } from '../dnr-engine.js'
import { loadStaticRulesets } from '../dnr-runner.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { blockRule, makeRequest } from './engine.test-helpers.js'
import type { DnrRule } from '../types.js'

/** `count` distinct block rules whose url filters all contain `tag`. */
function rules(tag: string, count: number, firstId = 1): DnrRule[] {
  return Array.from({ length: count }, (_, i) => blockRule(firstId + i, { urlFilter: `${tag}-${String(i)}.test` }))
}

describe('the global static rule pool', () => {
  it('lets one extension enable more static rules than its guaranteed minimum', () => {
    const engine = createDnrEngine()
    engine.setStaticRulesets('ext', [
      { id: 'a', enabled: true, rules: rules('a', 25_000) },
      { id: 'b', enabled: true, rules: rules('b', 25_000) },
    ])
    expect(engine.getEnabledRulesets('ext')).toEqual(['a', 'b'])
    expect(engine.evaluate(makeRequest({ url: 'https://a-1.test/' })).cancel).toBe(true)
    expect(engine.evaluate(makeRequest({ url: 'https://b-24999.test/' })).cancel).toBe(true)
  })

  it('refuses an enabled set beyond the guarantee plus what the pool still holds', () => {
    const engine = createDnrEngine({ globalStaticRulePool: 10 })
    engine.setStaticRulesets('ext', [
      { id: 'small', enabled: true, rules: rules('s', 30_000) },
      { id: 'big', enabled: false, rules: rules('g', 11, 40_000) },
    ])
    expect(() => engine.updateEnabledRulesets('ext', { enableRulesetIds: ['big'] })).toThrow(/global static rule limit/)
    // The rejected call changed nothing.
    expect(engine.getEnabledRulesets('ext')).toEqual(['small'])
    engine.updateEnabledRulesets('ext', { disableRulesetIds: ['small'], enableRulesetIds: ['big'] })
    expect(engine.getEnabledRulesets('ext')).toEqual(['big'])
  })

  it('shares one pool across extensions: what one draws, another cannot', () => {
    const engine = createDnrEngine({ globalStaticRulePool: 10 })
    engine.setStaticRulesets('first', [{ id: 'r', enabled: true, rules: rules('f', 30_008) }])
    engine.setStaticRulesets('second', [{ id: 'r', enabled: false, rules: rules('s', 30_005) }])
    expect(() => engine.updateEnabledRulesets('second', { enableRulesetIds: ['r'] })).toThrow(/global static rule limit/)
    engine.removeExtension('first')
    engine.updateEnabledRulesets('second', { enableRulesetIds: ['r'] })
    expect(engine.getEnabledRulesets('second')).toEqual(['r'])
  })

  it('at load, keeps the rulesets that fit and skips the rest instead of rejecting every one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const engine = createDnrEngine({ globalStaticRulePool: 10 })
    engine.setStaticRulesets('ext', [
      { id: 'fits', enabled: true, rules: rules('a', 30_005) },
      { id: 'too-big', enabled: true, rules: rules('b', 30, 40_000) },
    ])
    expect(engine.getEnabledRulesets('ext')).toEqual(['fits'])
    expect(engine.evaluate(makeRequest({ url: 'https://a-4.test/' })).cancel).toBe(true)
    expect(engine.evaluate(makeRequest({ url: 'https://b-4.test/' })).cancel).toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('reports the guaranteed headroom plus the pool that is left', () => {
    const engine = createDnrEngine({ globalStaticRulePool: 100 })
    expect(engine.getAvailableStaticRuleCount('ext')).toBe(30_000 + 100)
    engine.setStaticRulesets('ext', [{ id: 'a', enabled: true, rules: rules('a', 30_040) }])
    expect(engine.getAvailableStaticRuleCount('ext')).toBe(60)
  })

  it('still rejects past the pool in a single extension', () => {
    const engine = createDnrEngine({ globalStaticRulePool: 5 })
    engine.setStaticRulesets('ext', [{ id: 'a', enabled: false, rules: rules('a', 30_006) }])
    expect(() => engine.updateEnabledRulesets('ext', { enableRulesetIds: ['a'] })).toThrow(/global static rule limit/)
  })
})

describe('the cap on regex rules across enabled static rulesets', () => {
  const regexRules = (tag: string, count: number, firstId: number): DnrRule[] =>
    Array.from({ length: count }, (_, i) => blockRule(firstId + i, { regexFilter: `^https://${tag}-${String(i)}\\.test/` }))

  it('skips, at load, the ruleset that would pass it and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const engine = createDnrEngine()
    engine.setStaticRulesets('ext', [
      { id: 'one', enabled: true, rules: regexRules('a', 600, 1) },
      { id: 'two', enabled: true, rules: regexRules('b', 600, 1000) },
    ])
    expect(engine.getEnabledRulesets('ext')).toEqual(['one'])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/"two" not loaded.*MAX_NUMBER_OF_REGEX_RULES/))
    warn.mockRestore()
  })

  it('refuses, at a runtime enable, a set that would pass it, and changes nothing', () => {
    const engine = createDnrEngine()
    engine.setStaticRulesets('ext', [
      { id: 'one', enabled: true, rules: regexRules('a', 600, 1) },
      { id: 'two', enabled: false, rules: regexRules('b', 600, 1000) },
    ])
    expect(() => engine.updateEnabledRulesets('ext', { enableRulesetIds: ['two'] })).toThrow(/MAX_NUMBER_OF_REGEX_RULES/)
    expect(engine.getEnabledRulesets('ext')).toEqual(['one'])
  })
})

describe('a ruleset skipped at load for want of quota', () => {
  const setup = () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const engine = createDnrEngine({ globalStaticRulePool: 10 })
    engine.setStaticRulesets('ext', [
      { id: 'fits', enabled: true, rules: rules('a', 30_005) },
      { id: 'skipped', enabled: true, rules: rules('b', 30, 40_000) },
      { id: 'off', enabled: false, rules: rules('c', 3, 90_000) },
    ])
    return engine
  }

  it('is not reported as enabled but is kept as enabled when the choice is saved', () => {
    const engine = setup()
    expect(engine.getEnabledRulesets('ext')).toEqual(['fits'])
    expect(engine.getEnabledRulesetsToPersist('ext')).toEqual(['fits', 'skipped'])
  })

  it('is dropped from the saved choice once the extension disables it', () => {
    const engine = setup()
    engine.updateEnabledRulesets('ext', { disableRulesetIds: ['skipped'] })
    expect(engine.getEnabledRulesetsToPersist('ext')).toEqual(['fits'])
  })

  it('stays in the saved choice when the extension changes another ruleset', () => {
    const engine = setup()
    engine.updateEnabledRulesets('ext', { enableRulesetIds: ['off'] })
    expect(engine.getEnabledRulesetsToPersist('ext')).toEqual(['fits', 'skipped', 'off'])
  })
})

describe('lazily read static rulesets', () => {
  it('reads a ruleset the engine is told is disabled only when it is first enabled', () => {
    const read = vi.fn(() => rules('x', 3))
    const engine = createDnrEngine()
    engine.setStaticRulesets('ext', [{ id: 'later', enabled: false, rules: read }])
    expect(read).not.toHaveBeenCalled()
    engine.updateEnabledRulesets('ext', { enableRulesetIds: ['later'] })
    expect(read).toHaveBeenCalledTimes(1)
    expect(engine.evaluate(makeRequest({ url: 'https://x-1.test/' })).cancel).toBe(true)
    engine.updateEnabledRulesets('ext', { disableRulesetIds: ['later'] })
    engine.updateEnabledRulesets('ext', { enableRulesetIds: ['later'] })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('loadStaticRulesets does not open a disabled ruleset\'s file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orivon-dnr-lazy-'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      mkdirSync(join(dir, 'r'))
      writeFileSync(join(dir, 'r', 'on.json'), JSON.stringify(rules('o', 2)))
      writeFileSync(join(dir, 'r', 'off.json'), '{ not json')
      const loaded = loadStaticRulesets(dir, [
        { id: 'on', enabled: true, path: 'r/on.json' },
        { id: 'off', enabled: false, path: 'r/off.json' },
      ], null)
      expect(error).not.toHaveBeenCalled()
      expect(loaded[0]?.rules).toHaveLength(2)
      expect(typeof loaded[1]?.rules).toBe('function')
    } finally {
      error.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
