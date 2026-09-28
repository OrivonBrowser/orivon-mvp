import { describe, expect, it } from 'vitest'
import { parseManifest, type ManifestResult } from '../manifest.js'

// `Manifest.crossOriginIsolated` (src/contracts/manifest.ts) as the loader's
// parser reads it: `true` accepted, anything else refused by name, absent
// left out, and the field recognised as the contract's own rather than
// warned about as an unknown top-level key.

/** Required fields only, `capabilities: {}` -- the same deliberately small copy consent-granularity.test.ts keeps. */
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

describe('crossOriginIsolated', () => {
  it('accepts true, and recognises the key as the contract\'s own', () => {
    const result = parseManifest(JSON.stringify(minimal({ crossOriginIsolated: true })))
    if (!result.ok) throw new Error(result.reason)
    expect(result.manifest.crossOriginIsolated).toBe(true)
    expect(result.ignoredFields).toEqual([])
  })

  it('leaves the field out entirely when absent', () => {
    const result = parseManifest(JSON.stringify(minimal()))
    if (!result.ok) throw new Error(result.reason)
    expect('crossOriginIsolated' in result.manifest).toBe(false)
  })

  it.each([
    ['false', false],
    ['a string', 'yes'],
    ['a number', 1],
    ['null', null],
    ['an object', {}]
  ])('rejects %s by name', (_label, value) => {
    expect(reason(parseManifest(JSON.stringify(minimal({ crossOriginIsolated: value }))))).toContain('crossOriginIsolated must be true')
  })
})
