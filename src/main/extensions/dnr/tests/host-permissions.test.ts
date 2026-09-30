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

  // src/main/extensions/README.md's "allowFileAccess is never true" entry:
  // no extension ever gets file access, so file: is never covered here.
  // The shared matcher's <all_urls> already leaves it out; this checker
  // also refuses it for an explicit file pattern.
  it('never covers a file: request URL, even with <all_urls>', () => {
    const check = createHostAccessChecker(['<all_urls>'])
    expect(check(new URL('file:///etc/passwd'), null)).toBe(false)
  })

  it('never covers a file: request URL, even with an explicit file pattern', () => {
    const check = createHostAccessChecker(['file:///*'])
    expect(check(new URL('file:///etc/passwd'), null)).toBe(false)
  })

  it('never covers a file: initiator URL, even when the request URL matches', () => {
    const check = createHostAccessChecker(['<all_urls>'])
    expect(check(new URL('https://example.com/x'), new URL('file:///etc/passwd'))).toBe(false)
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
