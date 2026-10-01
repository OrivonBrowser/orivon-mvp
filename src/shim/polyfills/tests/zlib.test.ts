// Node's zlib takes any ArrayBufferView or ArrayBuffer, not only a Buffer: ethers hands gunzipSync
// the plain Uint8Array it collected from a response, and a package that predates that rule refuses it.

import { describe, expect, it } from 'vitest'
import * as zlib from '../zlib.js'

const TEXT = 'a response large enough to be compressed '.repeat(40)

describe('zlib accepts a plain Uint8Array and an ArrayBuffer', () => {
  const packed = zlib.gzipSync(TEXT)
  const plain = new Uint8Array(packed)

  it('gunzipSync reads a Uint8Array', () => {
    expect(String(zlib.gunzipSync(plain))).toBe(TEXT)
  })

  it('reads a view at an offset into a larger buffer, only its own bytes', () => {
    const wide = new Uint8Array(packed.length + 8)
    wide.set(packed, 4)
    expect(String(zlib.gunzipSync(wide.subarray(4, 4 + packed.length)))).toBe(TEXT)
  })

  it('inflateSync and unzipSync read an ArrayBuffer', () => {
    const deflated = new Uint8Array(zlib.deflateSync(TEXT))
    expect(String(zlib.inflateSync(deflated.buffer))).toBe(TEXT)
    expect(String(zlib.unzipSync(plain))).toBe(TEXT)
  })

  it('the callback forms accept one too', async () => {
    const out = await new Promise<Uint8Array>((resolve, reject) => {
      zlib.gunzip(plain, (error, result) => (error === null ? resolve(result) : reject(error)))
    })
    expect(String(out)).toBe(TEXT)
  })

  it('still takes a string and a Buffer, and still refuses a number', () => {
    expect(String(zlib.gunzipSync(packed))).toBe(TEXT)
    expect(zlib.deflateSync(TEXT).length).toBeGreaterThan(0)
    expect(() => zlib.gunzipSync(5 as never)).toThrow(TypeError)
  })
})
