import { describe, expect, it } from 'vitest'
import { MAX_QR_CHARACTERS, asciiOnly, matrixFor, qrDataLength } from '../overlay/qr/qr-svg.js'

describe('what the QR sheet measures', () => {
  it('counts the escaped text, which is longer than the address when it has letters outside ASCII', () => {
    const address = `ipfs://bafy/${'é'.repeat(700)}`
    expect(address.length).toBeLessThan(MAX_QR_CHARACTERS)
    expect(qrDataLength(address)).toBeGreaterThan(MAX_QR_CHARACTERS)
    expect(matrixFor(address)).toBeNull()
  })

  it('draws a code for an ordinary address and none for nothing', () => {
    expect(matrixFor('https://example.com/a')?.size).toBeGreaterThan(20)
    expect(matrixFor('')).toBeNull()
  })

  it('reads a lone surrogate as the replacement character instead of throwing', () => {
    expect(asciiOnly('a\ud800b')).toBe('a%EF%BF%BDb')
    expect(asciiOnly('a\udc00')).toBe('a%EF%BF%BD')
    expect(asciiOnly('😀')).toBe('%F0%9F%98%80')
    expect(matrixFor('https://example.com/\ud800')).not.toBeNull()
  })
})
