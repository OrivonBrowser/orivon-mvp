// capabilities.trust (ADR-0058): `{ "score": true }` declares the trust.score capability, as presence alone
// declares `secrets`. Anything else under `trust` is refused rather than read as a looser or absent declaration.

import { describe, expect, it } from 'vitest'
import { parseManifest } from '../manifest.js'
import { patternSetFromCapabilities } from '../../../broker/policy/manifest-patterns.js'

function parse (trust: unknown): ReturnType<typeof parseManifest> {
  return parseManifest(JSON.stringify({ orivonApiVersion: 0, id: 'app.test', name: 'Test', version: '1.0.0', entry: 'index.html', capabilities: { trust } }))
}

describe('capabilities.trust', () => {
  it('accepts { score: true } and turns it into the trust.score kind', () => {
    const result = parse({ score: true })
    if (!result.ok) throw new Error(result.reason)
    expect(result.manifest.capabilities.trust).toEqual({ score: true })
    expect(patternSetFromCapabilities(result.manifest.capabilities)).toEqual({ 'trust.score': [] })
  })

  it('accepts an empty object, which declares nothing', () => {
    const result = parse({})
    if (!result.ok) throw new Error(result.reason)
    expect(patternSetFromCapabilities(result.manifest.capabilities)).toEqual({})
  })

  it.each([
    ['false', { score: false }, /trust\.score must be true/],
    ['a string', { score: 'yes' }, /trust\.score must be true/],
    ['an unknown field', { score: true, history: true }, /unrecognised field/],
    ['an array', [], /must be an object/],
    ['a bare true', true, /must be an object/]
  ])('refuses %s', (_name, trust, message) => {
    const result = parse(trust)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(message)
  })
})
