import { describe, expect, it } from 'vitest'
import { extensionsReachingOrigin } from '../site-reach.js'

const NEVER_CACHED = (): boolean => false

describe('extensionsReachingOrigin', () => {
  it('names an extension whose host pattern covers the origin', () => {
    const names = extensionsReachingOrigin(
      'https://a.example',
      [{ name: 'Ad Blocker', hostPatterns: ['https://a.example/*'] }],
      NEVER_CACHED
    )
    expect(names).toEqual(['Ad Blocker'])
  })

  it('leaves out an extension whose host pattern does not cover the origin', () => {
    const names = extensionsReachingOrigin(
      'https://a.example',
      [{ name: 'Scoped Tool', hostPatterns: ['https://b.example/*'] }],
      NEVER_CACHED
    )
    expect(names).toEqual([])
  })

  it('treats <all_urls> as covering every origin', () => {
    const names = extensionsReachingOrigin(
      'https://a.example',
      [{ name: 'Everywhere', hostPatterns: ['<all_urls>'] }],
      NEVER_CACHED
    )
    expect(names).toEqual(['Everywhere'])
  })

  it('treats *://*/* as covering every http(s) origin', () => {
    const names = extensionsReachingOrigin(
      'https://a.example',
      [{ name: 'Everywhere Too', hostPatterns: ['*://*/*'] }],
      NEVER_CACHED
    )
    expect(names).toEqual(['Everywhere Too'])
  })

  it('names every covering extension, in the order given', () => {
    const names = extensionsReachingOrigin(
      'https://a.example',
      [
        { name: 'First', hostPatterns: ['<all_urls>'] },
        { name: 'Not Covering', hostPatterns: ['https://b.example/*'] },
        { name: 'Second', hostPatterns: ['https://a.example/*'] }
      ],
      NEVER_CACHED
    )
    expect(names).toEqual(['First', 'Second'])
  })

  it('returns none for an origin served from its pinned cache, without consulting the extension list', () => {
    const names = extensionsReachingOrigin(
      'https://a.example',
      [{ name: 'Everywhere', hostPatterns: ['<all_urls>'] }],
      () => true
    )
    expect(names).toEqual([])
  })

  it('returns none for no extensions', () => {
    expect(extensionsReachingOrigin('https://a.example', [], NEVER_CACHED)).toEqual([])
  })
})
