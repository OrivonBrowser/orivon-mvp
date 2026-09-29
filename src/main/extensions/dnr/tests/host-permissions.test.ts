import { describe, expect, it } from 'vitest'
import { buildActionAccess, createHostAccessChecker } from '../host-permissions.js'

// The match-pattern grammar itself (<all_urls>, scheme/host/path matching)
// is `../../../broker/policy/extension-host-patterns.ts`'s own
// `matchesHostPattern`/`matchesAnyHostPattern` -- see that file's tests.
// This file tests only what is DNR-specific: request+initiator, and the
// permission-name-to-DnrActionAccess mapping.
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
