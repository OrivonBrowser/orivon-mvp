import { describe, expect, it } from 'vitest'
import { ExtensionDNRLimits } from '../../../../vendor/firefox-dnr/src/dnr-limits.mjs'
import { declarativeNetRequestApi } from '../declarative-net-request.js'
import type { DnrActionType, DnrDomainType, DnrModifyHeaderOperation, DnrRequestMethod, DnrResourceType, DnrRuleCondition } from '../../../main/extensions/dnr/types.js'

/** What the entry defines on `chrome.declarativeNetRequest`, rebuilt from its source text as the library runs it. */
function defined (base: object | undefined = { getDynamicRules: 'method' }): Record<string, unknown> {
  const rebuilt = new Function(`return (${declarativeNetRequestApi.toString()})`)() as () => void
  let result: Record<string, unknown> = {}
  const crx = { define: (_ns: string, build: (b: unknown) => object) => { result = build(base) as Record<string, unknown> } }
  ;(globalThis as { __crx?: unknown }).__crx = crx
  try { rebuilt() } finally { delete (globalThis as { __crx?: unknown }).__crx }
  return result
}

const values = (value: unknown): string[] => Object.values(value as Record<string, string>).sort()

describe('chrome.declarativeNetRequest constants', () => {
  it('keeps the library\'s own methods', () => {
    expect(defined().getDynamicRules).toBe('method')
  })

  it('carries the engine\'s limits, which come from the vendored limits file', () => {
    const api = defined()
    for (const key of Object.keys(ExtensionDNRLimits) as Array<keyof typeof ExtensionDNRLimits>) {
      expect(api[key], key).toBe(ExtensionDNRLimits[key])
    }
  })

  it('carries the quota constants and the regex reasons the engine does not define, at Chrome\'s values', () => {
    const api = defined()
    expect(api.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES).toBe(5000)
    expect(api.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES).toBe(5000)
    expect(api.MAX_NUMBER_OF_UNSAFE_SESSION_RULES).toBe(5000)
    expect(api.GETMATCHEDRULES_QUOTA_INTERVAL).toBe(10)
    expect(api.MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL).toBe(20)
    expect(api.UnsupportedRegexReason).toEqual({ SYNTAX_ERROR: 'syntaxError', MEMORY_LIMIT_EXCEEDED: 'memoryLimitExceeded' })
  })

  it('names the dynamic and session rulesets as the engine does', () => {
    const api = defined()
    expect(api.DYNAMIC_RULESET_ID).toBe('_dynamic')
    expect(api.SESSION_RULESET_ID).toBe('_session')
  })

  it('has one enum value per type the engine accepts', () => {
    const resourceTypes: Record<DnrResourceType, true> = {
      main_frame: true, sub_frame: true, stylesheet: true, script: true, image: true, font: true, object: true,
      xmlhttprequest: true, ping: true, csp_report: true, media: true, websocket: true, webtransport: true,
      webbundle: true, other: true
    }
    const actions: Record<DnrActionType, true> = {
      allow: true, allowAllRequests: true, block: true, upgradeScheme: true, redirect: true, modifyHeaders: true
    }
    const methods: Record<DnrRequestMethod, true> = {
      connect: true, delete: true, get: true, head: true, options: true, patch: true, post: true, put: true, other: true
    }
    const domainTypes: Record<DnrDomainType, true> = { firstParty: true, thirdParty: true }
    const operations: Record<DnrModifyHeaderOperation, true> = { append: true, set: true, remove: true }
    const api = defined()
    expect(values(api.ResourceType)).toEqual(Object.keys(resourceTypes).sort())
    expect(values(api.RuleActionType)).toEqual(Object.keys(actions).sort())
    expect(values(api.RequestMethod)).toEqual(Object.keys(methods).sort())
    expect(values(api.DomainType)).toEqual(Object.keys(domainTypes).sort())
    expect(values(api.HeaderOperation)).toEqual(Object.keys(operations).sort())
  })

  it('lists exactly the condition keys the engine evaluates, and not TOP_DOMAINS', () => {
    const conditionKeys: Record<keyof DnrRuleCondition, true> = {
      urlFilter: true, regexFilter: true, isUrlFilterCaseSensitive: true, initiatorDomains: true,
      excludedInitiatorDomains: true, requestDomains: true, excludedRequestDomains: true, resourceTypes: true,
      excludedResourceTypes: true, requestMethods: true, excludedRequestMethods: true, domainType: true,
      tabIds: true, excludedTabIds: true
    }
    const api = defined()
    expect(values(api.RuleConditionKeys)).toEqual(Object.keys(conditionKeys).sort())
    expect((api.RuleConditionKeys as Record<string, string>).TOP_DOMAINS).toBeUndefined()
  })

  it('freezes every enum, so a page cannot rewrite what an extension reads', () => {
    const api = defined()
    for (const name of ['ResourceType', 'RuleActionType', 'RequestMethod', 'DomainType', 'HeaderOperation', 'UnsupportedRegexReason', 'RuleConditionKeys']) {
      expect(Object.isFrozen(api[name]), name).toBe(true)
    }
  })
})
