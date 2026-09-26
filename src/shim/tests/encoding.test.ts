// Node's fs encodings, decoded and encoded through the page's own `buffer`
// package (vitest.config.ts resolves it for shim modules, as the page does).

import { describe, expect, it } from 'vitest'
import { decode, encode } from '../encoding.js'
import { PageBuffer } from './support/page-buffer.js'

const HELLO = new TextEncoder().encode('hello')

describe('decode', () => {
  it('returns the page Buffer when no encoding is given, undefined or null', () => {
    expect(PageBuffer.isBuffer(decode(HELLO, undefined))).toBe(true)
    expect(PageBuffer.isBuffer(decode(HELLO, null))).toBe(true)
  })

  it.each([
    ['utf8', [0xc3, 0xa9], 'é'],
    ['UTF-8', [0xc3, 0xa9], 'é'],
    ['latin1', [0xe9], 'é'],
    ['binary', [0xe9], 'é'],
    ['ascii', [0x68, 0x69], 'hi'],
    ['ucs2', [0x68, 0x00, 0x69, 0x00], 'hi'],
    ['utf16le', [0x68, 0x00, 0x69, 0x00], 'hi'],
    ['hex', [0xde, 0xad], 'dead'],
    ['base64', [...HELLO], 'aGVsbG8='],
    ['base64url', [0xfb, 0xff], '-_8']
  ])('decodes %s', (encoding, bytes, text) => {
    expect(decode(new Uint8Array(bytes), encoding)).toBe(text)
  })

  it('refuses an unknown encoding the way Node does', () => {
    expect(() => decode(HELLO, 'klingon')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }))
  })
})

describe('encode', () => {
  it.each([
    ['utf8', 'é', [0xc3, 0xa9]],
    ['latin1', 'é', [0xe9]],
    ['binary', 'é', [0xe9]],
    ['utf16le', 'hi', [0x68, 0x00, 0x69, 0x00]],
    ['hex', 'dead', [0xde, 0xad]],
    ['base64', 'aGVsbG8=', [...HELLO]],
    ['base64url', '-_8', [0xfb, 0xff]]
  ])('encodes %s', (encoding, text, bytes) => {
    expect([...encode(text, encoding)]).toEqual(bytes)
  })

  it('defaults a string to utf8', () => {
    expect([...encode('é', undefined)]).toEqual([0xc3, 0xa9])
  })

  it('takes any TypedArray or DataView as its bytes, as Node writeFile does', () => {
    expect([...encode(new Uint16Array([0x0201]), undefined)]).toEqual([0x01, 0x02])
    expect([...encode(new DataView(new Uint8Array([7, 8]).buffer), undefined)]).toEqual([7, 8])
  })

  it('refuses an unknown encoding the way Node does', () => {
    expect(() => encode('x', 'klingon')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE' }))
  })
})
