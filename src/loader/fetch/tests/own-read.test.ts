import { describe, expect, it } from 'vitest'
import { OWN_READ_HEADER } from '../content-root.js'
import { asOwnRead, ownReadToken } from '../own-read.js'

describe('the mark on the main process\'s own reads of a host a protocol serves', () => {
  it('is a secret of at least 128 bits that is the same for the whole run', () => {
    expect(ownReadToken()).toMatch(/^[0-9a-f]{48}$/)
    expect(ownReadToken()).toBe(ownReadToken())
  })

  it.each([
    'https://kept.eth/app.js',
    'https://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi.ipfs.orivon/',
    'https://sub.name.eth/'
  ])('is added to a read of %s, beside the headers given', (url) => {
    expect(asOwnRead(url, { 'x-orivon-content-root': 'bafy' })).toEqual({ 'x-orivon-content-root': 'bafy', [OWN_READ_HEADER]: ownReadToken() })
    expect(asOwnRead(url)).toEqual({ [OWN_READ_HEADER]: ownReadToken() })
  })

  it.each([
    'https://example.com/app.js',
    'http://kept.eth/app.js',
    'https://gateway.example/ipfs/bafy',
    'not a url'
  ])('is never sent to %s: the secret reaches no server but the verifier\'s own', (url) => {
    expect(asOwnRead(url, { accept: '*/*' })).toEqual({ accept: '*/*' })
    expect(asOwnRead(url)).toEqual({})
  })

  it('does not change the headers it was given', () => {
    const given = { accept: '*/*' }
    asOwnRead('https://kept.eth/', given)
    expect(given).toEqual({ accept: '*/*' })
  })
})
