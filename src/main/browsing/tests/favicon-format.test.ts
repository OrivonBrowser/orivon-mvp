import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeDataUrl, looksLikeSvg, oneIcoImage, sniffImageType, toDataUrl } from '../favicon-format.js'

// A byte-order mark is invisible in an editor and in a diff, so one written
// literally into the sniffer or its tests cannot be reviewed.
it('spells U+FEFF as an escape, never as a literal character', () => {
  for (const file of ['../favicon-format.ts', './favicon-format.test.ts']) {
    expect(readFileSync(new URL(file, import.meta.url), 'utf8')).not.toContain(String.fromCharCode(0xfeff))
  }
})

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
    const doc = '\uFEFF <?xml version="1.0"?>\n<!-- generated -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg></svg>'
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

describe('toDataUrl', () => {
  it('builds a data: URL, typed from the bytes, for a PNG', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])
    expect(toDataUrl(bytes)).toBe(`data:image/png;base64,${Buffer.from(bytes).toString('base64')}`)
  })

  it('builds a data: URL for a real SVG document', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    expect(toDataUrl(svg)).toBe(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
  })

  it('builds a data: URL for an ICO, whatever a server might have labelled it', () => {
    const ico = new Uint8Array([0x00, 0x00, 0x01, 0x00, 1, 2, 3])
    expect(toDataUrl(ico)).toBe(`data:image/x-icon;base64,${Buffer.from(ico).toString('base64')}`)
  })

  it('rejects bytes that are not a recognised image at all', () => {
    expect(toDataUrl(new TextEncoder().encode('<!DOCTYPE html><html></html>'))).toBeNull()
    expect(toDataUrl(new Uint8Array(0))).toBeNull()
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

  // A SYSTEM literal may hold any character but its own quote, `>` included,
  // so the first `>` in the document is not where the DOCTYPE ends.
  it.each([
    ['a `>` inside a double-quoted SYSTEM literal', '<!DOCTYPE svg SYSTEM "><svg " [<!ENTITY a "x"><!ENTITY b "&a;&a;">]><svg>&b;</svg>'],
    ['the same behind a prolog and a comment', '<?xml version="1.0"?><!-- x --><!DOCTYPE svg SYSTEM "><svg/" [<!ENTITY a "x">]><svg/>'],
    ['a single-quoted literal', "<!DOCTYPE svg SYSTEM '><svg ' [<!ENTITY a \"x\">]><svg>&a;</svg>"],
    ['a PUBLIC id followed by a literal hiding `>`', '<!DOCTYPE svg PUBLIC "-//x//EN" "><svg " [<!ENTITY a "x">]><svg>&a;</svg>']
  ])('rejects an internal subset hidden behind %s', (_label, doc) => {
    expect(looksLikeSvg(doc)).toBe(false)
    expect(sniffImageType(new TextEncoder().encode(doc))).toBeNull()
  })

  it('accepts a quoted literal that contains `>` or `[` when no internal subset follows', () => {
    expect(looksLikeSvg('<!DOCTYPE svg SYSTEM "a>b[c]"><svg></svg>')).toBe(true)
  })

  it('rejects a doctype whose quoted literal never closes', () => {
    expect(looksLikeSvg('<!DOCTYPE svg SYSTEM "never closed><svg></svg>')).toBe(false)
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
  // decoded -- a page's own data: candidate is attacker-controlled.
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
    expect(decodeDataUrl('data:image/svg+xml,%zz', 1024)).toBeNull()
  })

  // A data: URL's body is percent-decoded before base64 decoding, per the
  // fetch spec's data: URL processor, and a `+` or `/` is often escaped.
  it('percent-decodes a base64 payload before decoding it', () => {
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0xfb, 0xff, 0xbf)
    const base64 = Buffer.from(png).toString('base64')
    expect(base64).toMatch(/[+/]/)
    const escaped = base64.replace(/\+/g, '%2B').replace(/\//g, '%2F')
    expect(decodeDataUrl(`data:image/png;base64,${escaped}`, 1024)).toEqual(png)
  })

  it('decodes a percent-encoded binary payload byte for byte', () => {
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff)
    const escaped = Array.from(png, (b) => `%${b.toString(16).padStart(2, '0')}`).join('')
    expect(decodeDataUrl(`data:image/png,${escaped}`, 1024)).toEqual(png)
  })

  it('rejects a non-data URL', () => {
    expect(decodeDataUrl('https://example.com/icon.png', 1024)).toBeNull()
  })
})

/** A type-1 `.ico` with one image per `[size, depth, fill]`, each image `size` bytes of `fill`. */
function ico (images: ReadonlyArray<readonly [number, number, number]>): Uint8Array {
  const header = 6 + images.length * 16
  const out = new Uint8Array(header + images.reduce((sum, [size]) => sum + size, 0))
  const view = new DataView(out.buffer)
  view.setUint16(2, 1, true)
  view.setUint16(4, images.length, true)
  let offset = header
  images.forEach(([size, depth, fill], i) => {
    const entry = 6 + i * 16
    out[entry] = size === 256 ? 0 : size
    out[entry + 1] = size === 256 ? 0 : size
    view.setUint16(entry + 4, 1, true)
    view.setUint16(entry + 6, depth, true)
    view.setUint32(entry + 8, size, true)
    view.setUint32(entry + 12, offset, true)
    out.fill(fill, offset, offset + size)
    offset += size
  })
  return out
}

describe('oneIcoImage', () => {
  it('keeps only the 32 px image of a 16, 32 and 64 px icon', () => {
    const kept = oneIcoImage(ico([[16, 32, 1], [32, 32, 2], [64, 32, 3]]))
    expect(kept).toEqual(ico([[32, 32, 2]]))
  })

  it('prefers the larger image, then the deeper colour, at the same distance from 32 px', () => {
    expect(oneIcoImage(ico([[16, 32, 1], [48, 8, 2]]))).toEqual(ico([[48, 8, 2]]))
    expect(oneIcoImage(ico([[32, 8, 1], [32, 32, 2]]))).toEqual(ico([[32, 32, 2]]))
  })

  it('leaves a one-image icon, a cursor, another format and a broken directory as they are', () => {
    const single = ico([[16, 32, 1]])
    expect(oneIcoImage(single)).toBe(single)
    const cursor = ico([[16, 32, 1], [32, 32, 2]])
    cursor[2] = 2
    expect(oneIcoImage(cursor)).toBe(cursor)
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])
    expect(oneIcoImage(png)).toBe(png)
    const pastTheEnd = ico([[16, 32, 1], [32, 32, 2]])
    new DataView(pastTheEnd.buffer).setUint32(6 + 16 + 12, 10_000, true)
    expect(oneIcoImage(pastTheEnd)).toBe(pastTheEnd)
  })

  it('is what toDataUrl encodes for a multi-image icon', () => {
    expect(toDataUrl(ico([[16, 32, 1], [32, 32, 2], [64, 32, 3]]))).toBe(`data:image/x-icon;base64,${Buffer.from(ico([[32, 32, 2]])).toString('base64')}`)
  })
})
