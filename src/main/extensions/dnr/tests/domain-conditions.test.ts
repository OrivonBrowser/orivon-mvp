import { describe, expect, it } from 'vitest'
import { createDnrEngine } from '../dnr-engine.js'
import { makeRequest } from './engine.test-helpers.js'

// requestDomains/excludedRequestDomains/initiatorDomains/
// excludedInitiatorDomains match the domain *and every subdomain of it*
// (test_ext_dnr_domainType.js and the domain conditions section of
// declarative_net_request.json's own doc comments), and domainType
// (firstParty/thirdParty) is derived from comparing base domains.
function blocksWithCondition(url: string, condition: object, initiator?: string): boolean {
  const engine = createDnrEngine()
  engine.updateSessionRules('ext', {
    addRules: [{ id: 1, priority: 1, condition, action: { type: 'block' } }],
  })
  const request = initiator === undefined ? makeRequest({ url }) : makeRequest({ url, initiator })
  return engine.evaluate(request).cancel === true
}

describe('requestDomains', () => {
  it('matches the exact domain', () => {
    expect(blocksWithCondition('http://example.com/', { requestDomains: ['example.com'] })).toBe(true)
  })

  it('matches a subdomain of the listed domain', () => {
    expect(blocksWithCondition('http://a.b.example.com/', { requestDomains: ['example.com'] })).toBe(true)
  })

  it('does not match a different domain that merely shares a suffix', () => {
    expect(blocksWithCondition('http://notexample.com/', { requestDomains: ['example.com'] })).toBe(false)
  })

  it('excludedRequestDomains excludes the domain and its subdomains', () => {
    expect(
      blocksWithCondition('http://a.example.com/', {
        requestDomains: ['com'],
        excludedRequestDomains: ['example.com'],
      })
    ).toBe(false)
  })
})

describe('initiatorDomains', () => {
  it('matches when the initiator is the domain or a subdomain of it', () => {
    expect(
      blocksWithCondition('http://target/', { initiatorDomains: ['example.com'] }, 'http://sub.example.com/')
    ).toBe(true)
  })

  it('does not match a request with no initiator', () => {
    expect(blocksWithCondition('http://target/', { initiatorDomains: ['example.com'] })).toBe(false)
  })

  it('excludedInitiatorDomains excludes that initiator', () => {
    expect(
      blocksWithCondition(
        'http://target/',
        { excludedInitiatorDomains: ['example.com'] },
        'http://sub.example.com/'
      )
    ).toBe(false)
  })
})

describe('domainType', () => {
  it('firstParty when the request and initiator share a base domain', () => {
    expect(
      blocksWithCondition('http://a.example.com/x', { domainType: 'firstParty' }, 'http://b.example.com/')
    ).toBe(true)
  })

  it('thirdParty when the request and initiator have different base domains', () => {
    expect(blocksWithCondition('http://example.com/x', { domainType: 'thirdParty' }, 'http://other.org/')).toBe(
      true
    )
  })

  it('a main_frame request (no initiator) is thirdParty', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [
        {
          id: 1,
          priority: 1,
          condition: { domainType: 'thirdParty', resourceTypes: ['main_frame'] },
          action: { type: 'block' },
        },
      ],
    })
    const decision = engine.evaluate(makeRequest({ url: 'http://example.com/', resourceType: 'main_frame' }))
    expect(decision.cancel).toBe(true)
  })

  it('recognizes a two-label public suffix (co.uk) as one base domain', () => {
    expect(
      blocksWithCondition('http://a.example.co.uk/', { domainType: 'firstParty' }, 'http://b.example.co.uk/')
    ).toBe(true)
    expect(
      blocksWithCondition('http://a.example.co.uk/', { domainType: 'firstParty' }, 'http://a.other.co.uk/')
    ).toBe(false)
  })

  // vendor/firefox-dnr/adapters/dnr-domain.mjs's getBaseDomain is now a real
  // public-suffix-list lookup (tldts), which the old fixed two-label-suffix
  // heuristic could not do: "github.io" is on the PSL's PRIVATE section, so
  // two different users' sites under it are correctly thirdParty.
  it('recognizes a PSL private suffix (github.io) as one base domain per user', () => {
    expect(
      blocksWithCondition('http://a.example.github.io/', { domainType: 'thirdParty' }, 'http://other.github.io/')
    ).toBe(true)
    expect(
      blocksWithCondition(
        'http://a.example.github.io/',
        { domainType: 'firstParty' },
        'http://sub.example.github.io/'
      )
    ).toBe(true)
  })

  // .orivon/.eth/<cid>.ipfs.orivon are not on the public suffix list;
  // dnr-domain.mjs's doc comment says exactly what tldts returns for them
  // and why. These lock that documented behavior in as a test.
  it('treats an unlisted custom TLD (.orivon, .eth) like a normal one', () => {
    expect(
      blocksWithCondition('http://a.example.orivon/', { domainType: 'firstParty' }, 'http://b.example.orivon/')
    ).toBe(true)
    expect(blocksWithCondition('http://app.eth/', { domainType: 'thirdParty' }, 'http://other.eth/')).toBe(true)
  })

  it('grades every <cid>.ipfs.orivon host firstParty with every other one (documented, provisional)', () => {
    expect(
      blocksWithCondition(
        'http://cid-one.ipfs.orivon/',
        { domainType: 'firstParty' },
        'http://cid-two.ipfs.orivon/'
      )
    ).toBe(true)
  })
})

describe('requestMethods / excludedRequestMethods', () => {
  function blocksWithMethod(method: string, condition: object): boolean {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [{ id: 1, priority: 1, condition, action: { type: 'block' } }],
    })
    return engine.evaluate(makeRequest({ url: 'http://example.com/', method })).cancel === true
  }

  it('requestMethods restricts matching to the listed methods', () => {
    expect(blocksWithMethod('post', { requestMethods: ['post'] })).toBe(true)
    expect(blocksWithMethod('get', { requestMethods: ['post'] })).toBe(false)
  })

  it('excludedRequestMethods excludes the listed methods', () => {
    expect(blocksWithMethod('get', { excludedRequestMethods: ['post'] })).toBe(true)
    expect(blocksWithMethod('post', { excludedRequestMethods: ['post'] })).toBe(false)
  })
})

describe('resourceTypes', () => {
  it('an unspecified resourceTypes condition ignores main_frame requests', () => {
    const engine = createDnrEngine()
    engine.updateSessionRules('ext', {
      addRules: [{ id: 1, priority: 1, condition: {}, action: { type: 'block' } }],
    })
    const decision = engine.evaluate(
      makeRequest({ url: 'http://example.com/', resourceType: 'main_frame' })
    )
    expect(decision.cancel).toBeUndefined()
  })
})
