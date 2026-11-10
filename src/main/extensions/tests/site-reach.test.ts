import { describe, expect, it } from 'vitest'
import { extensionsReachingOrigin } from '../site-reach.js'

const NEVER_APART = (): boolean => false

describe('extensionsReachingOrigin', () => {
  it('names an extension whose host pattern covers the origin', () => {
    const names = extensionsReachingOrigin(
      'https://a.example',
      [{ name: 'Ad Blocker', hostPatterns: ['https://a.example/*'] }],
      NEVER_APART
    )
    expect(names).toEqual(['Ad Blocker'])
  })

  it('leaves out an extension whose host pattern does not cover the origin', () => {
    const names = extensionsReachingOrigin(
      'https://a.example',
      [{ name: 'Scoped Tool', hostPatterns: ['https://b.example/*'] }],
      NEVER_APART
    )
    expect(names).toEqual([])
  })

  it('treats <all_urls> as covering every origin', () => {
    const names = extensionsReachingOrigin(
      'https://a.example',
      [{ name: 'Everywhere', hostPatterns: ['<all_urls>'] }],
      NEVER_APART
    )
    expect(names).toEqual(['Everywhere'])
  })

  it('treats *://*/* as covering every http(s) origin', () => {
    const names = extensionsReachingOrigin(
      'https://a.example',
      [{ name: 'Everywhere Too', hostPatterns: ['*://*/*'] }],
      NEVER_APART
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
      NEVER_APART
    )
    expect(names).toEqual(['First', 'Second'])
  })

  it('returns none for an app that runs in a partition of its own, without consulting the extension list', () => {
    const names = extensionsReachingOrigin(
      'https://a.example',
      [{ name: 'Everywhere', hostPatterns: ['<all_urls>'] }],
      () => true
    )
    expect(names).toEqual([])
  })

  it('returns none for no extensions', () => {
    expect(extensionsReachingOrigin('https://a.example', [], NEVER_APART)).toEqual([])
  })
})
