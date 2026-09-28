// capabilities.web.embed (ADR-0039): `origins` is required, each entry an
// exact http(s) origin or the bare "*", and "*" stands alone. The same
// "accepted and rejected spellings" coverage web-capability.test.ts gives
// capabilities.web.contexts, in its own file per that file's own header.

import { describe, expect, it } from 'vitest'
import { parseManifest } from '../manifest.js'
import type { WebCapability } from '../../../contracts/index.js'

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

describe('capabilities.web.embed (ADR-0039)', () => {
  it('accepts the bare "*"', () => {
    expect(parsed({ embed: { origins: ['*'] } }).embed).toEqual({ origins: ['*'] })
  })

  it('accepts exact https and http origins, with or without a port', () => {
    expect(parsed({ embed: { origins: ['https://a.example', 'http://b.example:8080'] } }).embed?.origins)
      .toEqual(['https://a.example', 'http://b.example:8080'])
  })

  it('accepts a loopback literal and a localhost name when named exactly (the person sees the address)', () => {
    expect(parsed({ embed: { origins: ['http://127.0.0.1:8080', 'http://localhost:3000'] } }).embed?.origins)
      .toEqual(['http://127.0.0.1:8080', 'http://localhost:3000'])
  })

  it('sits beside contexts, each parsed on its own', () => {
    const web = parsed({ contexts: ['https://www.youtube.com'], embed: { origins: ['*'] } })
    expect(web.contexts).toEqual(['https://www.youtube.com'])
    expect(web.embed).toEqual({ origins: ['*'] })
  })

  it('is optional -- omitting it is not an error', () => {
    expect(parsed({}).embed).toBeUndefined()
  })

  it('requires origins', () => {
    expect(rejection({ embed: {} })).toContain('origins is required')
  })

  it('rejects an empty origins list', () => {
    expect(rejection({ embed: { origins: [] } })).toContain('origins')
  })

  it('rejects "*" beside an exact origin', () => {
    expect(rejection({ embed: { origins: ['*', 'https://a.example'] } })).toContain('only entry')
  })

  it('rejects a bare host with no scheme', () => {
    expect(rejection({ embed: { origins: ['example.com'] } })).toContain('origins[0]')
  })

  it('rejects a scheme that is not http or https', () => {
    expect(rejection({ embed: { origins: ['file:///etc'] } })).toContain('http or https')
  })

  it('rejects a wildcard host', () => {
    expect(rejection({ embed: { origins: ['https://*.example.com'] } })).toContain('wildcard')
  })

  it('rejects a path, a query, a fragment and userinfo', () => {
    expect(rejection({ embed: { origins: ['https://example.com/watch'] } })).toContain('path')
    expect(rejection({ embed: { origins: ['https://example.com?x=1'] } })).toContain('query')
    expect(rejection({ embed: { origins: ['https://example.com#f'] } })).toContain('query')
    expect(rejection({ embed: { origins: ['https://u:p@example.com'] } })).toContain('userinfo')
  })

  it('rejects a non-canonical spelling', () => {
    expect(rejection({ embed: { origins: ['https://example.com/'] } })).toContain('canonical')
    expect(rejection({ embed: { origins: ['https://EXAMPLE.com'] } })).toContain('canonical')
  })

  it('rejects an unrecognised field inside embed', () => {
    expect(rejection({ embed: { origins: ['*'], script: true } })).toContain('unrecognised')
  })

  it('rejects embed that is not an object', () => {
    expect(rejection({ embed: ['*'] })).toContain('must be an object')
  })
})
