import { describe, expect, it } from 'vitest'
import { decodeDataUrl, looksLikeSvg, sniffImageType } from '../favicon-format.js'

function bytes (...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

describe('sniffImageType', () => {
  it('recognises PNG', () => {
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2))).toBe('image/png')
  })

  it('recognises JPEG', () => {
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0, 1, 2))).toBe('image/jpeg')
  })

  it('recognises GIF87a and GIF89a', () => {
    expect(sniffImageType(new TextEncoder().encode('GIF87a...'))).toBe('image/gif')
    expect(sniffImageType(new TextEncoder().encode('GIF89a...'))).toBe('image/gif')
  })

  it('recognises ICO and CUR as image/x-icon', () => {
    expect(sniffImageType(bytes(0x00, 0x00, 0x01, 0x00, 1, 2))).toBe('image/x-icon')
    expect(sniffImageType(bytes(0x00, 0x00, 0x02, 0x00, 1, 2))).toBe('image/x-icon')
  })

  it('recognises BMP', () => {
    expect(sniffImageType(bytes(0x42, 0x4d, 1, 2, 3))).toBe('image/bmp')
  })

  it('recognises WebP, skipping the RIFF size field', () => {
    const buf = new Uint8Array(16)
    buf.set(new TextEncoder().encode('RIFF'), 0)
    buf.set([0, 0, 0, 0], 4)
    buf.set(new TextEncoder().encode('WEBP'), 8)
    expect(sniffImageType(buf)).toBe('image/webp')
  })

  it('recognises AVIF, still and animated brands', () => {
    const still = new Uint8Array(16)
    still.set([0, 0, 0, 0x1c], 0)
    still.set(new TextEncoder().encode('ftyp'), 4)
    still.set(new TextEncoder().encode('avif'), 8)
    expect(sniffImageType(still)).toBe('image/avif')

    const animated = still.slice()
    animated.set(new TextEncoder().encode('avis'), 8)
    expect(sniffImageType(animated)).toBe('image/avif')
  })

  it('recognises a bare SVG document', () => {
    expect(sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('image/svg+xml')
  })

  it('recognises SVG behind an XML prolog, a doctype and comments', () => {
    const doc = '﻿ <?xml version="1.0"?>\n<!-- generated -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg></svg>'
    expect(sniffImageType(new TextEncoder().encode(doc))).toBe('image/svg+xml')
  })

  it('rejects an ordinary HTML document', () => {
    expect(sniffImageType(new TextEncoder().encode('<!DOCTYPE html><html><body>hi</body></html>'))).toBeNull()
  })

  it('rejects a JSON error body', () => {
    expect(sniffImageType(new TextEncoder().encode('{"error":"not found"}'))).toBeNull()
  })

  it('rejects an empty buffer', () => {
    expect(sniffImageType(new Uint8Array(0))).toBeNull()
  })
})

describe('looksLikeSvg', () => {
  it('rejects a doctype missing its closing >', () => {
    expect(looksLikeSvg('<!DOCTYPE svg')).toBe(false)
  })

  it('rejects an unterminated comment', () => {
    expect(looksLikeSvg('<!-- never closed <svg>')).toBe(false)
  })

  it('rejects an unterminated xml prolog', () => {
    expect(looksLikeSvg('<?xml version="1.0" <svg>')).toBe(false)
  })

  it('accepts a self-closing root element', () => {
    expect(looksLikeSvg('<svg/>')).toBe(true)
  })

  // A DOCTYPE's internal subset is where a "billion laughs" entity bomb is
  // declared (nested <!ENTITY> references that expand to gigabytes while
  // parsing, script or no script) -- refused outright, since a real
  // favicon's DOCTYPE never legitimately needs one.
  it('rejects a DOCTYPE with an internal subset, even a small, well-formed one', () => {
    const bomb = '<!DOCTYPE svg [<!ENTITY a "x"><!ENTITY b "&a;&a;">]><svg>&b;</svg>'
    expect(looksLikeSvg(bomb)).toBe(false)
  })

  it('still accepts an ordinary PUBLIC/SYSTEM doctype with no internal subset', () => {
    const doc = '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg></svg>'
    expect(looksLikeSvg(doc)).toBe(true)
  })
})

describe('decodeDataUrl', () => {
  it('decodes a base64 payload', () => {
    const png = bytes(0x89, 0x50, 0x4e, 0x47)
    const url = `data:image/png;base64,${Buffer.from(png).toString('base64')}`
    expect(decodeDataUrl(url, 1024)).toEqual(png)
  })

  it('decodes a percent-encoded SVG payload', () => {
    const url = 'data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E'
    expect(new TextDecoder().decode(decodeDataUrl(url, 1024)!)).toBe('<svg></svg>')
  })

  // A percent-encoded payload is rejected by LENGTH alone before it is ever
  // decodeURIComponent'd or re-encoded -- the same "reject before the
  // potentially huge decode" guarantee the base64 branch's own pre-check
  // gives, since a page's own data: candidate is attacker-controlled.
  it('rejects an oversized percent-encoded payload without decoding it', () => {
    const huge = '%41'.repeat(10_000) // each triple decodes to one byte
    expect(decodeDataUrl(`data:image/svg+xml,${huge}`, 10)).toBeNull()
  })

  it('rejects a payload over the cap', () => {
    const url = `data:image/png;base64,${Buffer.from(new Uint8Array(100)).toString('base64')}`
    expect(decodeDataUrl(url, 10)).toBeNull()
  })

  it('accepts a payload exactly at the cap', () => {
    const bytesAtCap = new Uint8Array(10)
    const url = `data:image/png;base64,${Buffer.from(bytesAtCap).toString('base64')}`
    expect(decodeDataUrl(url, 10)).toEqual(bytesAtCap)
  })

  // Node's base64 decoder is lenient by design (it skips characters outside
  // the alphabet rather than throwing), so this never signals "malformed" --
  // whatever bytes come out of a garbled payload fail sniffImageType instead,
  // which is where "not really an image" is actually decided.
  it('decodes whatever a non-alphabet character leaves behind, rather than throwing', () => {
    expect(() => decodeDataUrl('data:image/png;base64,not valid base64!!', 1024)).not.toThrow()
  })

  it('rejects a malformed percent-escape', () => {
    expect(decodeDataUrl('data:image/svg+xml,%', 1024)).toBeNull()
  })

  it('rejects a non-data URL', () => {
    expect(decodeDataUrl('https://example.com/icon.png', 1024)).toBeNull()
  })
})
