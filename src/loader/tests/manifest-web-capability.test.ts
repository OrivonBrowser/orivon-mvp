// capabilities.web (ADR-0019): each declared context origin is an EXACT
// https origin -- no wildcard, no path, no userinfo, no query/fragment, and
// no address literal outside public unicast or localhost name. This file is
// the same "accepted and rejected spellings" coverage manifest-capabilities.
// test.ts already gives capabilities.net.https.connect, kept in its own file
// per that file's own header (it stays at the Rule 2 test-file limit).

import { describe, expect, it } from 'vitest'
import { parseManifest } from '../manifest.js'
import type { WebCapability } from '../../contracts/index.js'

function manifestWith (web: unknown): unknown {
  return {
    orivonApiVersion: 0,
    id: 'app.test',
    name: 'Test',
    version: '1.0.0',
    entry: 'index.html',
    capabilities: { web }
  }
}

function parsed (web: unknown): WebCapability {
  const result = parseManifest(JSON.stringify(manifestWith(web)))
  if (!result.ok) throw new Error(`expected the manifest to parse, and it was rejected: ${result.reason}`)
  return result.manifest.capabilities.web ?? {}
}

function rejection (web: unknown): string {
  const result = parseManifest(JSON.stringify(manifestWith(web)))
  if (result.ok) throw new Error('expected the manifest to be rejected, and it parsed instead')
  return result.reason
}

describe('capabilities.web.contexts (ADR-0019)', () => {
  it('accepts an exact https origin with no port', () => {
    expect(parsed({ contexts: ['https://www.youtube.com'] }).contexts).toEqual(['https://www.youtube.com'])
  })

  it('accepts an exact https origin carrying an explicit non-default port', () => {
    expect(parsed({ contexts: ['https://example.com:8443'] }).contexts).toEqual(['https://example.com:8443'])
  })

  it('accepts more than one declared origin', () => {
    expect(parsed({ contexts: ['https://a.example', 'https://b.example'] }).contexts)
      .toEqual(['https://a.example', 'https://b.example'])
  })

  it('is optional -- omitting it is not an error', () => {
    expect(parsed({}).contexts).toBeUndefined()
  })

  it('rejects a bare host with no scheme', () => {
    expect(rejection({ contexts: ['www.youtube.com'] })).toContain('contexts[0]')
  })

  it('rejects plain http', () => {
    expect(rejection({ contexts: ['http://example.com'] })).toContain('https')
  })

  it('rejects a wildcard host', () => {
    expect(rejection({ contexts: ['https://*.example.com'] })).toBeTruthy()
  })

  it('rejects a path beyond the bare origin', () => {
    expect(rejection({ contexts: ['https://example.com/watch'] })).toContain('path')
  })

  it('rejects a trailing slash -- not the canonical origin spelling', () => {
    expect(rejection({ contexts: ['https://example.com/'] })).toContain('canonical')
  })

  it('rejects userinfo', () => {
    expect(rejection({ contexts: ['https://user:pass@example.com'] })).toContain('userinfo')
  })

  it('rejects a query string', () => {
    expect(rejection({ contexts: ['https://example.com?x=1'] })).toContain('query')
  })

  it('rejects a fragment', () => {
    expect(rejection({ contexts: ['https://example.com#frag'] })).toContain('query')
  })

  it('rejects a non-canonical spelling that still parses to the same origin (explicit default port)', () => {
    expect(rejection({ contexts: ['https://example.com:443'] })).toContain('canonical')
  })

  it('rejects a non-canonical case spelling', () => {
    expect(rejection({ contexts: ['https://EXAMPLE.com'] })).toContain('canonical')
  })

  it('rejects the bare "localhost" name', () => {
    expect(rejection({ contexts: ['https://localhost'] })).toContain('localhost')
  })

  // `new URL('https://localhost.')`'s hostname keeps the trailing root-label
  // dot (`'localhost.'`) and its own `.origin` reproduces it too, so this
  // passes the canonical-form check untouched -- only isLocalhostName's own
  // trailing-dot handling (origin.ts) stands between this and 'null' (accepted).
  it('rejects "localhost." -- a trailing root-label dot does not escape the namespace', () => {
    expect(rejection({ contexts: ['https://localhost.'] })).toContain('localhost')
  })

  it('rejects the whole .localhost namespace, not just the bare label', () => {
    expect(rejection({ contexts: ['https://app.localhost'] })).toContain('localhost')
  })

  it('rejects a loopback address literal', () => {
    expect(rejection({ contexts: ['https://127.0.0.1'] })).toContain('public unicast')
  })

  it('rejects a private-range address literal', () => {
    expect(rejection({ contexts: ['https://192.168.1.1'] })).toContain('public unicast')
  })

  it('rejects the link-local cloud metadata address', () => {
    expect(rejection({ contexts: ['https://169.254.169.254'] })).toContain('public unicast')
  })

  it('accepts a public IPv4 address literal', () => {
    expect(parsed({ contexts: ['https://93.184.216.34'] }).contexts).toEqual(['https://93.184.216.34'])
  })

  it('rejects an unrecognised field alongside contexts', () => {
    expect(rejection({ contexts: ['https://example.com'], other: true })).toContain('unrecognised')
  })

  it('rejects an empty array -- omit the field instead', () => {
    expect(rejection({ contexts: [] })).toContain('empty')
  })
})
