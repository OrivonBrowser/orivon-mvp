import { describe, expect, it } from 'vitest'
import { carryPageUrl, isCarryPageUrl } from '../carry-page.js'

describe('the address of the shell\'s empty document', () => {
  it('is recognised with the query that names its carry, at any origin, and nothing else is', () => {
    const nonce = 'ab'.repeat(16)
    expect(isCarryPageUrl(carryPageUrl('https://wiki.eth', nonce))).toBe(true)
    expect(isCarryPageUrl(carryPageUrl('https://app.example:8443', nonce))).toBe(true)
    expect(isCarryPageUrl('https://wiki.eth/')).toBe(false)
    expect(isCarryPageUrl('https://wiki.eth/.well-known/orivon/storage-carry-guessed?n=' + nonce)).toBe(false)
    expect(isCarryPageUrl('not a url')).toBe(false)
  })
})
