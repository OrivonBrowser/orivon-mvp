import { describe, expect, it } from 'vitest'
import { parseOmniboxInput, sanitizeDirectUrl } from './omnibox.js'

// Security-critical: the four rows under "dangerous schemes never navigate"
// are what stop the address bar from being a script-injection or local-file
// disclosure vector. Everything else is ordinary usability.
describe('parseOmniboxInput', () => {
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

    it('a punycode/IDN domain is a URL', () => {
      expect(parseOmniboxInput('xn--exmple-cua.com')).toEqual({
        kind: 'url',
        url: 'https://xn--exmple-cua.com/'
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
