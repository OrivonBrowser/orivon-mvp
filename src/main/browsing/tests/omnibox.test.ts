import { describe, expect, it } from 'vitest'
import { parseOmniboxInput, sanitizeDirectUrl } from '../omnibox.js'

// Security-critical: the four rows under "dangerous schemes never navigate"
// are what stop the address bar from being a script-injection or local-file
// disclosure vector. Everything else is ordinary usability.
describe('parseOmniboxInput', () => {
  describe('a leading question mark', () => {
    const search = (query: string): string => `https://search.test/?q=${encodeURIComponent(query)}`
    const parse = (text: string): ReturnType<typeof parseOmniboxInput> => parseOmniboxInput(text, () => false, search)

    it.each([['? cats', 'cats'], ['?cats', 'cats'], ['  ?  two words ', 'two words'], ['? example.com', 'example.com'], ['?javascript:alert(1)', 'javascript:alert(1)']])(
      'always searches for what follows: %j', (text, query) => {
        expect(parse(text)).toEqual({ kind: 'search', url: search(query) })
      }
    )

    it.each(['?', '?   ', ' ? '])('has nothing to search for in %j', (text) => {
      expect(parse(text)).toEqual({ kind: 'reject', reason: 'empty' })
    })

    it('leaves a question mark inside the text to the ordinary rules', () => {
      expect(parse('example.com/?q=1')).toEqual({ kind: 'url', url: 'https://example.com/?q=1' })
    })
  })

  it('a typed ipfs:// or ipns:// address loads from its scheme endpoint, whatever its case', () => {
    expect(parseOmniboxInput('  IPFS://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi  ')).toEqual({ kind: 'url', url: 'https://ipfs.orivon/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/' })
    expect(parseOmniboxInput('ipns://k51qzi5uqu5dipklqpo2uq7advlajxx5wxob0mwyqbxb5zu4htblc4bjipy834/docs#top')).toEqual({ kind: 'url', url: 'https://ipns.orivon/k51qzi5uqu5dipklqpo2uq7advlajxx5wxob0mwyqbxb5zu4htblc4bjipy834/docs#top' })
  })

  describe('recognised as a URL', () => {
    it('a bare domain gets https:// prepended', () => {
      expect(parseOmniboxInput('example.com')).toEqual({
        kind: 'url',
        url: 'https://example.com/'
      })
    })

    it('a full URL passes through', () => {
      expect(parseOmniboxInput('https://example.com/path?q=1')).toEqual({
        kind: 'url',
        url: 'https://example.com/path?q=1'
      })
    })

    it('an http URL is not upgraded to https', () => {
      expect(parseOmniboxInput('http://example.com')).toEqual({
        kind: 'url',
        url: 'http://example.com/'
      })
    })

    it('localhost with a port is a URL', () => {
      expect(parseOmniboxInput('localhost:3000')).toEqual({
        kind: 'url',
        url: 'http://localhost:3000/'
      })
    })

    it('a bare IPv4 literal is a URL', () => {
      expect(parseOmniboxInput('127.0.0.1')).toEqual({
        kind: 'url',
        url: 'https://127.0.0.1/'
      })
    })

    it('a bracketed IPv6 literal is a URL', () => {
      expect(parseOmniboxInput('[::1]:8080')).toEqual({
        kind: 'url',
        url: 'http://[::1]:8080/'
      })
    })

    it('an internationalised domain typed in its own letters is a URL, in punycode', () => {
      expect(parseOmniboxInput('münchen.de')).toEqual({ kind: 'url', url: 'https://xn--mnchen-3ya.de/' })
      expect(parseOmniboxInput('bücher.de/x')).toEqual({ kind: 'url', url: 'https://xn--bcher-kva.de/x' })
      expect(parseOmniboxInput('пример.рф').kind).toBe('url')
    })

    it('a one-word machine name with a port, a capitalised localhost and a bracketed IPv6 with a path are URLs', () => {
      expect(parseOmniboxInput('nas:5000')).toEqual({ kind: 'url', url: 'http://nas:5000/' })
      expect(parseOmniboxInput('LOCALHOST:3000')).toEqual({ kind: 'url', url: 'http://localhost:3000/' })
      expect(parseOmniboxInput('Localhost')).toEqual({ kind: 'url', url: 'https://localhost/' })
      expect(parseOmniboxInput('[::1]:8080/api')).toEqual({ kind: 'url', url: 'http://[::1]:8080/api' })
    })

    it('a word alone, a dotted word ending in a number and a decimal are searches, never a blank page or an IP address', () => {
      for (const text of ['nas', 'python3.12', 'v1.2', '3.14', '1.5', 'es2015.1']) {
        expect(parseOmniboxInput(text, () => false, (q) => `S:${q}`), text).toEqual({ kind: 'search', url: `S:${text}` })
      }
    })

    it('a punycode/IDN domain is a URL', () => {
      expect(parseOmniboxInput('xn--exmple-cua.com')).toEqual({
        kind: 'url',
        url: 'https://xn--exmple-cua.com/'
      })
    })

    // A `.eth` name is served by the verifier over https; only a
    // developer-mode name from orivon-ports' names file is plain http on
    // loopback, with no certificate to present.
    it('a bare .eth name defaults to https, where the verifier serves it', () => {
      expect(parseOmniboxInput('vitalik.eth')).toEqual({ kind: 'url', url: 'https://vitalik.eth/' })
      expect(parseOmniboxInput('app.ens.eth/path')).toEqual({ kind: 'url', url: 'https://app.ens.eth/path' })
    })

    it('a developer-mode .eth name defaults to http, case-insensitively', () => {
      const dev = (host: string): boolean => host === 'freetube.eth'
      expect(parseOmniboxInput('freetube.eth', dev)).toEqual({ kind: 'url', url: 'http://freetube.eth/' })
      expect(parseOmniboxInput('FreeTube.ETH', dev)).toEqual({ kind: 'url', url: 'http://freetube.eth/' })
      expect(parseOmniboxInput('vitalik.eth', dev)).toEqual({ kind: 'url', url: 'https://vitalik.eth/' })
    })

    it('an explicit https scheme on a .eth name is left alone, not downgraded', () => {
      expect(parseOmniboxInput('https://freetube.eth')).toEqual({
        kind: 'url',
        url: 'https://freetube.eth/'
      })
    })

    // The check is on the HOST portion only -- a path segment that happens
    // to end in .eth must not flip an ordinary domain's default scheme.
    it('a path ending in .eth does not affect an ordinary domain\'s https default', () => {
      expect(parseOmniboxInput('example.com/x.eth')).toEqual({
        kind: 'url',
        url: 'https://example.com/x.eth'
      })
    })

    it('leading/trailing whitespace is trimmed', () => {
      expect(parseOmniboxInput('  example.com  ')).toEqual({
        kind: 'url',
        url: 'https://example.com/'
      })
    })
  })

  describe('recognised as a search', () => {
    it('a phrase with spaces becomes a DuckDuckGo query', () => {
      expect(parseOmniboxInput('how do torrents work')).toEqual({
        kind: 'search',
        url: 'https://duckduckgo.com/?q=how+do+torrents+work'
      })
    })

    it('a single word that is not a domain becomes a search', () => {
      expect(parseOmniboxInput('torrents')).toEqual({
        kind: 'search',
        url: 'https://duckduckgo.com/?q=torrents'
      })
    })

    it('whitespace-only input is a search for nothing meaningful -> rejected, not searched', () => {
      // No query worth sending; reject rather than round-trip an empty search.
      expect(parseOmniboxInput('   ')).toEqual({
        kind: 'reject',
        reason: 'empty'
      })
    })

    it('special characters in a search phrase are query-encoded', () => {
      expect(parseOmniboxInput('c++ vs rust?')).toEqual({
        kind: 'search',
        url: 'https://duckduckgo.com/?q=c%2B%2B+vs+rust%3F'
      })
    })
  })

  describe('dangerous schemes never navigate — always reject', () => {
    it.each([
      'javascript:alert(1)',
      'javascript:void(document.cookie)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'file://C:/Windows/System32',
      'about:blank',
      'about:config'
    ])('rejects %s', (raw) => {
      const result = parseOmniboxInput(raw)
      expect(result.kind).toBe('reject')
    })

    // Case is a classic bypass vector for a naive prefix check -- lock this
    // down explicitly rather than relying on the schemes above happening to
    // be lowercase.
    it.each(['JAVASCRIPT:alert(1)', 'Data:text/html,x', 'FILE:///etc/passwd', 'About:blank'])(
      'rejects %s regardless of scheme case',
      (raw) => {
        expect(parseOmniboxInput(raw).kind).toBe('reject')
      }
    )
  })

  describe('edge cases', () => {
    it('empty string is rejected', () => {
      expect(parseOmniboxInput('')).toEqual({
        kind: 'reject',
        reason: 'empty'
      })
    })
  })
})

// sanitizeDirectUrl is for URL ARGUMENTS, not typed address-bar text --
// setWindowOpenHandler's `details.url` (a page asking to open a popup) and
// "open link in new tab" both hand over something that is already meant to
// be an absolute URL, never free text a user typed. It must NOT have
// parseOmniboxInput's search-fallback behaviour: plain text here is not a
// query to run, it is a caller (possibly a hostile page) that failed to
// supply a real URL, and the safe response is to reject, not guess.
describe('sanitizeDirectUrl', () => {
  it("an ipfs:// or ipns:// link becomes its scheme's https endpoint, never an unknown scheme", () => {
    expect(sanitizeDirectUrl('ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/a?b')).toBe('https://ipfs.orivon/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/a?b')
    expect(sanitizeDirectUrl('ipns://en.wikipedia-on-ipfs.org')).toBe('https://ipns.orivon/en.wikipedia-on-ipfs.org/')
    expect(sanitizeDirectUrl('magnet:?xt=urn:btih:abc')).toBeNull()
  })

  it('an absolute https URL passes through', () => {
    expect(sanitizeDirectUrl('https://example.com/path')).toBe('https://example.com/path')
  })

  it('an absolute http URL passes through', () => {
    expect(sanitizeDirectUrl('http://example.com/')).toBe('http://example.com/')
  })

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'about:blank'
  ])('rejects dangerous scheme %s -> null', (raw) => {
    expect(sanitizeDirectUrl(raw)).toBeNull()
  })

  it('plain text is rejected, NOT sent to search (unlike parseOmniboxInput)', () => {
    expect(sanitizeDirectUrl('some plain text, not a url')).toBeNull()
  })

  it('a bare domain with no scheme is rejected -- this function does not guess', () => {
    expect(sanitizeDirectUrl('example.com')).toBeNull()
  })

  it('empty string is rejected', () => {
    expect(sanitizeDirectUrl('')).toBeNull()
  })
})
