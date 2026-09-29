import { describe, expect, it } from 'vitest'
import { createDnrEngine } from '../dnr-engine.js'
import { createHostAccessChecker } from '../host-permissions.js'
import { makeRequest, blockRule } from './engine.test-helpers.js'
import type { DnrRule } from '../types.js'

const NO_ACCESS = { hasHostAccess: () => false, requiresHostAccessForAllActions: false }
const ALL_ACCESS = { hasHostAccess: () => true, requiresHostAccessForAllActions: false }

function redirectRule(id: number, urlFilter: string, url: string): DnrRule {
  return { id, priority: 1, condition: { urlFilter }, action: { type: 'redirect', redirect: { url } } }
}

function modifyHeadersRule(id: number, urlFilter: string): DnrRule {
  return {
    id,
    priority: 1,
    condition: { urlFilter },
    action: { type: 'modifyHeaders', responseHeaders: [{ header: 'x-test', operation: 'set', value: '1' }] },
  }
}

describe('setActionAccess: redirect/modifyHeaders only', () => {
  it('a redirect rule from an extension without host access does not fire', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', { addRules: [redirectRule(1, 'x', 'https://elsewhere/')] })
    engine.setActionAccess('ext', NO_ACCESS)
    expect(engine.evaluate(makeRequest({ url: 'http://x/' })).redirectUrl).toBeUndefined()
  })

  it('the same rule fires once host access is granted', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', { addRules: [redirectRule(1, 'x', 'https://elsewhere/')] })
    engine.setActionAccess('ext', ALL_ACCESS)
    expect(engine.evaluate(makeRequest({ url: 'http://x/' })).redirectUrl).toBe('https://elsewhere/')
  })

  it('a disqualified redirect rule falls through to a lower-precedence block rule', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [redirectRule(1, 'x', 'https://elsewhere/'), blockRule(2, { urlFilter: 'x' })],
    })
    engine.setActionAccess('ext', NO_ACCESS)
    const decision = engine.evaluate(makeRequest({ url: 'http://x/' }))
    expect(decision.redirectUrl).toBeUndefined()
    expect(decision.cancel).toBe(true)
  })

  it('a disqualified redirect rule falls through to another extension with access', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('blocked-ext', { addRules: [redirectRule(1, 'x', 'https://from-blocked/')] })
    engine.setActionAccess('blocked-ext', NO_ACCESS)
    engine.updateSessionRules('allowed-ext', { addRules: [redirectRule(1, 'x', 'https://from-allowed/')] })
    engine.setActionAccess('allowed-ext', ALL_ACCESS)
    expect(engine.evaluate(makeRequest({ url: 'http://x/' })).redirectUrl).toBe('https://from-allowed/')
  })

  it('block/allow/upgradeScheme are not gated by host access at all', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', { addRules: [blockRule(1, { urlFilter: 'x' })] })
    engine.setActionAccess('ext', NO_ACCESS)
    expect(engine.evaluate(makeRequest({ url: 'http://x/' })).cancel).toBe(true)
  })

  it('a modifyHeaders rule from an extension without host access is dropped', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', { addRules: [modifyHeadersRule(1, 'x')] })
    engine.setActionAccess('ext', NO_ACCESS)
    expect(engine.evaluate(makeRequest({ url: 'http://x/' })).responseHeaders).toBeUndefined()
  })

  it('checks the request URL through a real match-pattern-based checker', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', { addRules: [redirectRule(1, 'x', 'https://elsewhere/')] })
    engine.setActionAccess('ext', {
      hasHostAccess: createHostAccessChecker(['*://only-this-host/*']),
      requiresHostAccessForAllActions: false,
    })
    expect(engine.evaluate(makeRequest({ url: 'http://x/' })).redirectUrl).toBeUndefined()
    expect(engine.evaluate(makeRequest({ url: 'http://only-this-host/x' })).redirectUrl).toBe('https://elsewhere/')
  })
})

describe('setActionAccess: requiresHostAccessForAllActions', () => {
  it('gates even a block rule when true', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', { addRules: [blockRule(1, { urlFilter: 'x' })] })
    engine.setActionAccess('ext', { hasHostAccess: () => false, requiresHostAccessForAllActions: true })
    expect(engine.evaluate(makeRequest({ url: 'http://x/' })).cancel).toBeUndefined()
  })
})

describe('setActionAccess: default (unset)', () => {
  it('matches as if the extension held full permission everywhere', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', { addRules: [redirectRule(1, 'x', 'https://elsewhere/')] })
    expect(engine.evaluate(makeRequest({ url: 'http://x/' })).redirectUrl).toBe('https://elsewhere/')
  })
})
