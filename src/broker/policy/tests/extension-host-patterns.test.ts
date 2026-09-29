import { describe, expect, it } from 'vitest'
import { matchesAnyHostPattern, matchesHostPattern } from '../extension-host-patterns.js'

describe('matchesHostPattern', () => {
  it('matches <all_urls> against any http(s)/ftp URL, never a file:// one', () => {
    expect(matchesHostPattern('<all_urls>', 'https://a.example/path')).toBe(true)
    expect(matchesHostPattern('<all_urls>', 'http://a.example/')).toBe(true)
    expect(matchesHostPattern('<all_urls>', 'ftp://a.example/')).toBe(true)
    expect(matchesHostPattern('<all_urls>', 'file:///etc/passwd')).toBe(false)
  })

  it('a * scheme matches http and https only', () => {
    expect(matchesHostPattern('*://a.example/*', 'https://a.example/x')).toBe(true)
    expect(matchesHostPattern('*://a.example/*', 'http://a.example/x')).toBe(true)
    expect(matchesHostPattern('*://a.example/*', 'ftp://a.example/x')).toBe(false)
  })

  it('a literal scheme matches only that scheme', () => {
    expect(matchesHostPattern('https://a.example/*', 'http://a.example/x')).toBe(false)
    expect(matchesHostPattern('https://a.example/*', 'https://a.example/x')).toBe(true)
  })

  it('a *. host wildcard matches the host itself and every subdomain, never a different host', () => {
    expect(matchesHostPattern('https://*.example.com/*', 'https://example.com/x')).toBe(true)
    expect(matchesHostPattern('https://*.example.com/*', 'https://mail.example.com/x')).toBe(true)
    expect(matchesHostPattern('https://*.example.com/*', 'https://a.b.example.com/x')).toBe(true)
    expect(matchesHostPattern('https://*.example.com/*', 'https://evilexample.com/x')).toBe(false)
    expect(matchesHostPattern('https://*.example.com/*', 'https://example.com.evil.test/x')).toBe(false)
  })

  it('a bare * host matches every host', () => {
    expect(matchesHostPattern('https://*/*', 'https://anything.example/x')).toBe(true)
  })

  it('an exact host matches only that host, case-insensitively', () => {
    expect(matchesHostPattern('https://a.example/*', 'https://a.example/x')).toBe(true)
    expect(matchesHostPattern('https://a.example/*', 'https://A.EXAMPLE/x')).toBe(true)
    expect(matchesHostPattern('https://a.example/*', 'https://b.example/x')).toBe(false)
  })

  it('a path glob matches a prefix, never a different path when the pattern has no trailing *', () => {
    expect(matchesHostPattern('https://a.example/foo/*', 'https://a.example/foo/bar')).toBe(true)
    expect(matchesHostPattern('https://a.example/foo', 'https://a.example/foo')).toBe(true)
    expect(matchesHostPattern('https://a.example/foo', 'https://a.example/foobar')).toBe(false)
  })

  it('refuses an unparsable pattern or URL rather than guessing', () => {
    expect(matchesHostPattern('not-a-pattern', 'https://a.example/x')).toBe(false)
    expect(matchesHostPattern('https://a.example/*', 'not-a-url')).toBe(false)
  })

  it('a literal ? in the path matches the query-string separator literally, never as a regex quantifier', () => {
    expect(matchesHostPattern('https://a.example/api?*', 'https://a.example/api?foo=bar')).toBe(true)
    expect(matchesHostPattern('https://a.example/api?*', 'https://a.example/api')).toBe(false)
    expect(matchesHostPattern('https://a.example/api?*', 'https://a.example/apfoo')).toBe(false)
    expect(matchesHostPattern('https://a.example/api?*', 'https://a.example/apiXfoo')).toBe(false)
  })

  it('matches a many-`*` path pattern against a long path in a few milliseconds, not seconds', () => {
    const pattern = '/*a*a*a*a*a*a*b'
    const path = `/${'a'.repeat(99)}c` // never ends in "b": the worst case, no early exit on a match
    const startedAt = performance.now()
    expect(matchesHostPattern(`https://a.example${pattern}`, `https://a.example${path}`)).toBe(false)
    expect(performance.now() - startedAt).toBeLessThan(200)
  })
})

describe('matchesAnyHostPattern', () => {
  it('is true when any one pattern in the set matches', () => {
    expect(matchesAnyHostPattern(['https://b.example/*', 'https://a.example/*'], 'https://a.example/x')).toBe(true)
  })

  it('is false when the set is empty or none match', () => {
    expect(matchesAnyHostPattern([], 'https://a.example/x')).toBe(false)
    expect(matchesAnyHostPattern(['https://b.example/*'], 'https://a.example/x')).toBe(false)
  })
})
