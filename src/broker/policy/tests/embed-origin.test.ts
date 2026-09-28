import { describe, expect, it } from 'vitest'
import { ANY_SITE, embedAdmissionKind, embedDocumentAllowed, embedOriginRejection } from '../embed-origin.js'

// ADR-0039's two decisions: which strings a manifest may declare under
// web.embed.origins, and which document a shown page may then load. The
// second is the security boundary: a wrong answer there shows a person a
// site the app was never granted, or lets "*" reach the LAN (T12).

describe('embedOriginRejection -- accepted spellings', () => {
  it.each([
    ['the bare wildcard', ANY_SITE],
    ['an https origin', 'https://example.com'],
    ['an http origin', 'http://example.com'],
    ['a non-default port', 'https://example.com:8443'],
    ['a public address literal', 'https://93.184.216.34'],
    ['a loopback literal, named exactly', 'http://127.0.0.1:8080'],
    ['a localhost name, named exactly', 'http://localhost:3000'],
    ['a private-range literal, named exactly', 'http://192.168.1.1']
  ])('accepts %s', (_label, pattern) => {
    expect(embedOriginRejection(pattern)).toBeNull()
  })
})

describe('embedOriginRejection -- rejected spellings', () => {
  it.each([
    ['a bare host', 'example.com', 'unparseable'],
    ['a scheme that is not http(s)', 'ftp://example.com', 'not-http'],
    ['a file URL', 'file:///etc/passwd', 'not-http'],
    ['a wildcard host', 'https://*.example.com', 'wildcard-host'],
    ['userinfo', 'https://user:pass@example.com', 'userinfo'],
    ['a query', 'https://example.com?x=1', 'query-or-fragment'],
    ['a fragment', 'https://example.com#frag', 'query-or-fragment'],
    ['a path', 'https://example.com/watch', 'path'],
    ['a trailing slash', 'https://example.com/', 'not-canonical'],
    ['an explicit default port', 'https://example.com:443', 'not-canonical'],
    ['upper case', 'https://EXAMPLE.com', 'not-canonical'],
    ['a wildcard with a scheme', 'https://*', 'wildcard-host']
  ])('rejects %s as %s', (_label, pattern, reason) => {
    expect(embedOriginRejection(pattern)).toBe(reason)
  })
})

describe('embedDocumentAllowed -- an exact origin', () => {
  const granted = ['https://example.com', 'http://localhost:3000']

  it('allows a document at the granted origin, any path', () => {
    expect(embedDocumentAllowed('https://example.com/some/page?x=1#y', granted)).toBe(true)
  })

  it('allows a localhost origin the manifest named exactly', () => {
    expect(embedDocumentAllowed('http://localhost:3000/', granted)).toBe(true)
  })

  it.each([
    ['another origin', 'https://other.example/'],
    ['a subdomain', 'https://www.example.com/'],
    ['the same host over the other scheme', 'http://example.com/'],
    ['the same host on another port', 'https://example.com:8443/'],
    ['a file URL', 'file:///etc/passwd'],
    ['a chrome URL', 'chrome://gpu'],
    ['a string that is not a URL', 'not a url']
  ])('refuses %s', (_label, url) => {
    expect(embedDocumentAllowed(url, granted)).toBe(false)
  })
})

describe('embedDocumentAllowed -- "*"', () => {
  const any = [ANY_SITE]

  it.each([
    ['any https site', 'https://anything.example/path'],
    ['any http site', 'http://anything.example/'],
    ['a public address literal', 'http://93.184.216.34/'],
    ['about:blank', 'about:blank'],
    ['a data: document', 'data:text/html,<p>hi</p>'],
    ['a blob: document minted by a public site', 'blob:https://anything.example/123e4567-e89b-12d3-a456-426614174000']
  ])('allows %s', (_label, url) => {
    expect(embedDocumentAllowed(url, any)).toBe(true)
  })

  it.each([
    ['a loopback literal', 'http://127.0.0.1:8080/'],
    ['an IPv6 loopback literal', 'http://[::1]:8080/'],
    ['a private-range literal', 'http://192.168.1.1/'],
    ['the link-local metadata address', 'http://169.254.169.254/'],
    ['the bare localhost name', 'http://localhost:3000/'],
    ['a .localhost name', 'http://app.localhost/'],
    ['a blob: document minted by a loopback origin', 'blob:http://127.0.0.1:8080/123e4567-e89b-12d3-a456-426614174000'],
    ['a file URL', 'file:///etc/passwd'],
    ['a chrome URL', 'chrome://gpu']
  ])('refuses %s (T12)', (_label, url) => {
    expect(embedDocumentAllowed(url, any)).toBe(false)
  })

  it('refuses everything with no patterns at all', () => {
    expect(embedDocumentAllowed('https://anything.example/', [])).toBe(false)
    expect(embedDocumentAllowed('about:blank', [])).toBe(true)
  })
})

// A286/C-7: embedDocumentAllowed's own boolean cannot say whether the
// admitting pattern was an exact origin (ADR-0039 lets it be private, no
// address check ever needed) or "*" alone (whose hostname still needs its
// connected address checked -- embed-guard.ts's own job, not this file's).
describe('embedAdmissionKind -- HOW a document load is admitted', () => {
  it('is "exact" for an exact-origin match, even when "*" is also granted', () => {
    const patterns = [ANY_SITE, 'https://example.com']
    expect(embedAdmissionKind('https://example.com/page', patterns)).toEqual({ kind: 'exact' })
  })

  it('is "exact" for an exact-origin match appearing after "*" in the pattern list', () => {
    // The loop keeps scanning past a wildcard match, so an exact match
    // later in the array still wins -- exact never needs a lookup.
    const patterns = ['https://example.com', ANY_SITE]
    expect(embedAdmissionKind('https://example.com/page', patterns)).toEqual({ kind: 'exact' })
  })

  it('is "exact" for about:, data: and a blob: minted by an exactly-granted origin', () => {
    const patterns = ['https://example.com']
    expect(embedAdmissionKind('about:blank', patterns)).toEqual({ kind: 'exact' })
    expect(embedAdmissionKind('data:text/html,<p>hi</p>', patterns)).toEqual({ kind: 'exact' })
    expect(embedAdmissionKind('blob:https://example.com/123e4567-e89b-12d3-a456-426614174000', patterns))
      .toEqual({ kind: 'exact' })
  })

  it('is "wildcard", carrying the hostname, when only "*" admits it', () => {
    expect(embedAdmissionKind('https://anything.example/path', [ANY_SITE]))
      .toEqual({ kind: 'wildcard', hostname: 'anything.example' })
  })

  it('is "wildcard" for a public address literal admitted only by "*"', () => {
    expect(embedAdmissionKind('http://93.184.216.34/', [ANY_SITE]))
      .toEqual({ kind: 'wildcard', hostname: '93.184.216.34' })
  })

  it('is "refused" for a loopback/private/localhost host under "*" (the pure hostname gate stays first)', () => {
    expect(embedAdmissionKind('http://127.0.0.1:8080/', [ANY_SITE])).toEqual({ kind: 'refused' })
    expect(embedAdmissionKind('http://192.168.1.1/', [ANY_SITE])).toEqual({ kind: 'refused' })
    expect(embedAdmissionKind('http://localhost:3000/', [ANY_SITE])).toEqual({ kind: 'refused' })
  })

  it('is "refused" for a non-matching origin, an unparseable URL, or no patterns at all', () => {
    expect(embedAdmissionKind('https://other.example/', ['https://example.com'])).toEqual({ kind: 'refused' })
    expect(embedAdmissionKind('not a url', ['https://example.com'])).toEqual({ kind: 'refused' })
    expect(embedAdmissionKind('https://anything.example/', [])).toEqual({ kind: 'refused' })
  })

  it('embedDocumentAllowed is exactly embedAdmissionKind(...).kind !== \'refused\'', () => {
    const cases: Array<[string, readonly string[]]> = [
      ['https://example.com/page', ['https://example.com']],
      ['https://anything.example/', [ANY_SITE]],
      ['http://127.0.0.1/', [ANY_SITE]],
      ['https://other.example/', ['https://example.com']]
    ]
    for (const [url, patterns] of cases) {
      expect(embedDocumentAllowed(url, patterns)).toBe(embedAdmissionKind(url, patterns).kind !== 'refused')
    }
  })
})
