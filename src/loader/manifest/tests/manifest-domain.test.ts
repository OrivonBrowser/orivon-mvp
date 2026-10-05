import { describe, expect, it } from 'vitest'
import { parseManifest, type ManifestResult } from '../manifest.js'

// `Manifest.domain` (src/contracts/manifest.ts): the one ENS name or DNS host
// an app names as its home. The parser holds it to the exact spelling a URL
// gives a host, so the shell's origin comparison is a plain string compare.

function minimal (overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orivonApiVersion: 0,
    id: 'app.orivon.test',
    name: 'Test App',
    version: '1.0.0',
    entry: 'index.html',
    capabilities: {},
    ...overrides
  }
}

function reason (result: ManifestResult): string {
  if (result.ok) throw new Error('expected a rejection, got ok:true')
  return result.reason
}

describe('domain', () => {
  it.each(['thelounge.orivonstack.eth', 'app.example.com', 'xn--bcher-kva.example', 'a.b', `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`])('accepts %s', (domain) => {
    const result = parseManifest(minimal({ domain }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.domain).toBe(domain)
    expect(result.ignoredFields).toEqual([])
  })

  it('accepts absence and carries no key for it', () => {
    const result = parseManifest(minimal())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.hasOwn(result.manifest, 'domain')).toBe(false)
  })

  it.each([
    ['a scheme', 'https://x.eth'],
    ['upper case', 'X.ETH'],
    ['a trailing dot', 'x.eth.'],
    ['a port', 'x.eth:443'],
    ['a path', 'x.eth/a'],
    ['an IPv4 address', '1.2.3.4'],
    ['an IPv6 literal', '[::1]'],
    ['localhost', 'localhost'],
    ['a name under localhost', 'app.localhost'],
    ['one label', 'eth'],
    ['a content-address host', 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi.ipfs.orivon'],
    ['the orivon pseudo-TLD', 'x.orivon'],
    ['an empty label', 'a..eth'],
    ['a leading hyphen', '-a.eth'],
    ['userinfo', 'u@x.eth'],
    ['whitespace', 'x .eth'],
    ['a non-ASCII spelling', 'bücher.example'],
    ['254 characters', `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`],
    ['a 64-character label', `${'a'.repeat(64)}.eth`],
    ['the empty string', '']
  ])('rejects %s', (_label, domain) => {
    expect(reason(parseManifest(minimal({ domain })))).toMatch(/^domain /)
  })

  it.each([[42], [null], [true], [['x.eth']], [{}]])('rejects the non-string %j', (domain) => {
    expect(reason(parseManifest(minimal({ domain })))).toMatch(/^domain /)
  })
})
