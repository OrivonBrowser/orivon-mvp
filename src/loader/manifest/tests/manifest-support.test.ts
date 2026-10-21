import { describe, expect, it } from 'vitest'
import { parseManifest, type ManifestResult } from '../manifest.js'

// `Manifest.support` (src/contracts/manifest.ts): where the publisher wants a problem with the
// app reported. The shell shows it as a link, so the parser holds it to one absolute https: URL.

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

describe('support', () => {
  it.each([
    'https://github.com/OrivonBrowser/orivon-ports/issues/new?template=port-problem.yml&app=Element',
    'https://example.com',
    'https://tracker.example.com:8443/report#form',
    'https://xn--bcher-kva.example/issues'
  ])('accepts %s', (issues) => {
    const result = parseManifest(minimal({ support: { issues } }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.support).toEqual({ issues })
    expect(result.ignoredFields).toEqual([])
  })

  it('accepts absence and carries no key for it', () => {
    const result = parseManifest(minimal())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.hasOwn(result.manifest, 'support')).toBe(false)
  })

  it('skips a key of support this build does not know, and keeps issues', () => {
    const result = parseManifest(minimal({ support: { issues: 'https://example.com/i', chat: 'https://example.com/c' } }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.support).toEqual({ issues: 'https://example.com/i' })
  })

  it.each([
    ['http', 'http://example.com/issues'],
    ['mailto', 'mailto:help@example.com'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,<p>hi</p>'],
    ['file', 'file:///etc/passwd'],
    ['orivon', 'orivon://settings'],
    ['a scheme with no slashes', 'https:example.com'],
    ['a relative path', '/issues'],
    ['a bare host', 'example.com/issues'],
    ['credentials', 'https://user:pw@example.com/issues'],
    ['a user name alone', 'https://user@example.com/issues'],
    ['whitespace', 'https://example.com/is sues'],
    ['a newline', 'https://example.com/\nissues'],
    ['a bidi override', 'https://example.com/‮issues'],
    ['no host', 'https://'],
    ['an empty string', ''],
    ['more than 2048 characters', `https://example.com/${'a'.repeat(2048)}`]
  ])('rejects %s', (_label, issues) => {
    expect(reason(parseManifest(minimal({ support: { issues } })))).toMatch(/^support\.issues /)
  })

  it.each([
    ['a string', 'https://example.com/issues', /support must be an object/],
    ['an array', ['https://example.com/issues'], /support must be an object/],
    ['null', null, /support must be an object/],
    ['an empty object', {}, /support\.issues is required/],
    ['an issues number', { issues: 7 }, /support\.issues must be a string/],
    ['an issues null', { issues: null }, /support\.issues must be a string/]
  ])('rejects support given as %s', (_label, support, pattern) => {
    expect(reason(parseManifest(minimal({ support })))).toMatch(pattern)
  })

  it('reads an inherited issues key as absent', () => {
    const support = Object.create({ issues: 'https://example.com/issues' }) as Record<string, unknown>
    expect(reason(parseManifest(minimal({ support })))).toMatch(/support\.issues is required/)
  })
})
