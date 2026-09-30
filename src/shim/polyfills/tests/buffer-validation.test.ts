// buffer.isUtf8 and buffer.isAscii, checked against Node's own: `ws` calls the first for every
// text frame it receives, and treats its presence as a reason to prefer it.

import { isAscii as nodeIsAscii, isUtf8 as nodeIsUtf8 } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import bufferModule, { isAscii, isUtf8 } from '../buffer.js'

const samples: Uint8Array[] = [
  new Uint8Array([]),
  new TextEncoder().encode('plain ascii'),
  new TextEncoder().encode('café € \u{1f600}'),
  new Uint8Array([0xc3]),
  new Uint8Array([0xff, 0xfe]),
  new Uint8Array([0xed, 0xa0, 0x80]),
  new Uint8Array([0xef, 0xbb, 0xbf, 0x41]),
  new Uint8Array([0xc0, 0x80])
]

describe('buffer.isUtf8 and buffer.isAscii', () => {
  it.each(samples.map((bytes, index) => [index, bytes] as const))('agree with Node for sample %i', (_index, bytes) => {
    expect(isUtf8(bytes)).toBe(nodeIsUtf8(bytes))
    expect(isAscii(bytes)).toBe(nodeIsAscii(bytes))
  })

  it('take an ArrayBuffer or a view at an offset, and refuse anything else as Node does', () => {
    const backing = new TextEncoder().encode('xxé').buffer
    expect(isUtf8(backing)).toBe(true)
    expect(isUtf8(new Uint8Array(backing, 3))).toBe(false)
    expect(isAscii(new Uint8Array(backing, 0, 2))).toBe(true)
    expect(() => isUtf8('text')).toThrowError(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }) as Error)
  })

  it('are on the default export, so a destructuring require finds real functions', () => {
    expect(bufferModule.isUtf8).toBe(isUtf8)
    expect(bufferModule.isAscii).toBe(isAscii)
  })
})
