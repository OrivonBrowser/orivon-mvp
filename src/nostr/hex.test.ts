import { describe, expect, it } from 'vitest'
import { hexToBytes, toLowercaseHex } from './hex.js'

describe('toLowercaseHex', () => {
  it('encodes bytes as lowercase, zero-padded hex', () => {
    expect(toLowercaseHex(Uint8Array.of(0x00, 0x0f, 0xff, 0xa1))).toBe('000fffa1')
  })

  it('encodes the empty array as the empty string', () => {
    expect(toLowercaseHex(new Uint8Array(0))).toBe('')
  })
})

describe('hexToBytes', () => {
  it('round-trips toLowercaseHex output', () => {
    const original = Uint8Array.of(0x00, 0x0f, 0xff, 0xa1, 0x7e)
    expect(hexToBytes(toLowercaseHex(original))).toEqual(original)
  })

  it('accepts uppercase hex', () => {
    expect(hexToBytes('0A1B')).toEqual(Uint8Array.of(0x0a, 0x1b))
  })

  it('rejects an odd-length string', () => {
    expect(() => hexToBytes('abc')).toThrow(/odd/i)
  })

  it('rejects a non-hex character', () => {
    expect(() => hexToBytes('zz')).toThrow(/hex/i)
  })
})
