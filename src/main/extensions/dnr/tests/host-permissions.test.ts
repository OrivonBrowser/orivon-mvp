import { describe, expect, it } from 'vitest'
import { buildActionAccess, createHostAccessChecker, hostPatternMatchesUrl } from '../host-permissions.js'

describe('hostPatternMatchesUrl', () => {
  it('matches <all_urls> against anything http(s)', () => {
    expect(hostPatternMatchesUrl('<all_urls>', new URL('https://example.com/x'))).toBe(true)
    expect(hostPatternMatchesUrl('<all_urls>', new URL('http://example.com/x'))).toBe(true)
  })

  it('matches a subdomain wildcard host', () => {
    expect(hostPatternMatchesUrl('*://*.example.com/*', new URL('https://a.example.com/x'))).toBe(true)
    expect(hostPatternMatchesUrl('*://*.example.com/*', new URL('https://example.com/x'))).toBe(true)
    expect(hostPatternMatchesUrl('*://*.example.com/*', new URL('https://other.com/x'))).toBe(false)
  })

  it('scheme "*" matches only http/https', () => {
    expect(hostPatternMatchesUrl('*://example.com/*', new URL('https://example.com/'))).toBe(true)
    expect(hostPatternMatchesUrl('*://example.com/*', new URL('ftp://example.com/'))).toBe(false)
  })

  it('rejects a non-matching path', () => {
    expect(hostPatternMatchesUrl('https://example.com/admin/*', new URL('https://example.com/other'))).toBe(false)
    expect(hostPatternMatchesUrl('https://example.com/admin/*', new URL('https://example.com/admin/x'))).toBe(true)
  })

  it('rejects an exact host that does not match', () => {
    expect(hostPatternMatchesUrl('https://example.com/*', new URL('https://sub.example.com/'))).toBe(false)
  })
})

describe('createHostAccessChecker', () => {
  it('requires the request URL to match, and the initiator when one is given', () => {
    const check = createHostAccessChecker(['*://*.example.com/*'])
    expect(check(new URL('https://example.com/x'), null)).toBe(true)
    expect(check(new URL('https://example.com/x'), new URL('https://example.com/'))).toBe(true)
    expect(check(new URL('https://example.com/x'), new URL('https://other.com/'))).toBe(false)
    expect(check(new URL('https://other.com/x'), null)).toBe(false)
  })
})

describe('buildActionAccess', () => {
  it('requiresHostAccessForAllActions is false for plain declarativeNetRequest', () => {
    const access = buildActionAccess(['declarativeNetRequest'], ['<all_urls>'])
    expect(access.requiresHostAccessForAllActions).toBe(false)
  })

  it('requiresHostAccessForAllActions is true for a withHostAccess-only extension', () => {
    const access = buildActionAccess(['declarativeNetRequestWithHostAccess'], ['<all_urls>'])
    expect(access.requiresHostAccessForAllActions).toBe(true)
  })
})
