import { describe, expect, it } from 'vitest'
import { createDnrEngine } from '../dnr-engine.js'
import { createHostAccessChecker } from '../host-permissions.js'
import { makeRequest, blockRule } from './engine.test-helpers.js'
import type { DnrResourceType, DnrRule } from '../types.js'

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

// vendor/firefox-dnr/UPSTREAM.md patch 15, citing developer.chrome.com's
// declarativeNetRequest reference ("Host permissions" section): host
// permission for the request URL is required for redirect/modifyHeaders;
// host permission for the INITIATOR is additionally required for every
// request EXCEPT a navigation request (main_frame/sub_frame), where only
// the request URL is checked.
describe('setActionAccess: the host-access gate never checks the initiator for a navigation request', () => {
  /** Access to the target host always; access to the initiator only when it
   * is ALSO the target host -- 'blocked-initiator' never has access, so a
   * rule reachable only via this checker's initiator branch would refuse. */
  function hasAccessToTargetOnly(requestURI: URL, initiatorURI: URL | null): boolean {
    if (requestURI.hostname !== 'allowed-target') return false
    return initiatorURI === null || initiatorURI.hostname === 'allowed-target'
  }

  /** A redirect rule with an explicit resourceTypes: unlike redirectRule
   * above, a condition with none of resourceTypes/excludedResourceTypes
   * ignores main_frame requests entirely (Chrome's documented default,
   * ported as-is) -- these tests are about the host-access gate, not that
   * default, so every rule here says explicitly which resource types it
   * covers. */
  function navigationRedirectRule(id: number, urlFilter: string, url: string, resourceTypes: DnrResourceType[]): DnrRule {
    return { id, priority: 1, condition: { urlFilter, resourceTypes }, action: { type: 'redirect', redirect: { url } } }
  }

  it('a main_frame redirect fires even though its initiator has no access', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [navigationRedirectRule(1, 'allowed-target', 'https://elsewhere/', ['main_frame'])],
    })
    engine.setActionAccess('ext', { hasHostAccess: hasAccessToTargetOnly, requiresHostAccessForAllActions: false })
    const decision = engine.evaluate(
      makeRequest({ url: 'http://allowed-target/x', resourceType: 'main_frame', initiator: 'http://blocked-initiator/' })
    )
    expect(decision.redirectUrl).toBe('https://elsewhere/')
  })

  it('a sub_frame redirect also fires even though its initiator has no access', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [navigationRedirectRule(1, 'allowed-target', 'https://elsewhere/', ['sub_frame'])],
    })
    engine.setActionAccess('ext', { hasHostAccess: hasAccessToTargetOnly, requiresHostAccessForAllActions: false })
    const decision = engine.evaluate(
      makeRequest({ url: 'http://allowed-target/x', resourceType: 'sub_frame', initiator: 'http://blocked-initiator/' })
    )
    expect(decision.redirectUrl).toBe('https://elsewhere/')
  })

  it('the SAME extension\'s subresource redirect from the SAME blocked initiator does not fire -- non-navigation requests still gate on the initiator', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', { addRules: [redirectRule(1, 'allowed-target', 'https://elsewhere/')] })
    engine.setActionAccess('ext', { hasHostAccess: hasAccessToTargetOnly, requiresHostAccessForAllActions: false })
    const decision = engine.evaluate(
      makeRequest({ url: 'http://allowed-target/x', resourceType: 'xmlhttprequest', initiator: 'http://blocked-initiator/' })
    )
    expect(decision.redirectUrl).toBeUndefined()
  })

  it('a main_frame request with NO initiator at all still only needs the request URL (unaffected, same as before)', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [navigationRedirectRule(1, 'allowed-target', 'https://elsewhere/', ['main_frame'])],
    })
    engine.setActionAccess('ext', { hasHostAccess: hasAccessToTargetOnly, requiresHostAccessForAllActions: false })
    const decision = engine.evaluate(makeRequest({ url: 'http://allowed-target/x', resourceType: 'main_frame' }))
    expect(decision.redirectUrl).toBe('https://elsewhere/')
  })

  it('initiatorDomains condition matching (unrelated to the host-access gate) still sees a main_frame request\'s initiator', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [
        {
          id: 1,
          priority: 1,
          action: { type: 'block' },
          condition: { urlFilter: 'allowed-target', resourceTypes: ['main_frame'], initiatorDomains: ['blocked-initiator'] },
        },
      ],
    })
    // No setActionAccess at all -- block is never gated on host access
    // (setActionAccess's own default-unset test, above); this isolates the
    // condition match itself from the gate this describe block is about.
    const matches = engine.evaluate(
      makeRequest({ url: 'http://allowed-target/x', resourceType: 'main_frame', initiator: 'http://blocked-initiator/' })
    )
    expect(matches.cancel).toBe(true)
  })
})
