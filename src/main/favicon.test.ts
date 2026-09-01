import { describe, expect, it } from 'vitest'
import { MAX_FAVICON_BYTES, pickFaviconUrl, readCapped, shouldClearFavicon, toDataUrl } from './favicon.js'

describe('pickFaviconUrl', () => {
  it('returns null for an empty list', () => {
    expect(pickFaviconUrl([])).toBeNull()
  })

  it('picks the first http(s) candidate', () => {
    expect(pickFaviconUrl(['https://a.example/icon.png', 'https://b.example/icon.png']))
      .toBe('https://a.example/icon.png')
    expect(pickFaviconUrl(['http://a.example/icon.png'])).toBe('http://a.example/icon.png')
  })

  it('skips non-http(s) candidates and returns the first real one', () => {
    expect(pickFaviconUrl(['data:image/png;base64,AAA=', 'https://a.example/icon.png']))
      .toBe('https://a.example/icon.png')
  })

  it('returns null when nothing is http(s)', () => {
    expect(pickFaviconUrl(['data:image/png;base64,AAA=', 'javascript:alert(1)'])).toBeNull()
  })
})

function streamOf (chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start (controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    }
  })
}

describe('readCapped', () => {
  it('returns null for a null body', async () => {
    await expect(readCapped(null, 100)).resolves.toBeNull()
  })

  it('concatenates chunks under the cap', async () => {
    const stream = streamOf([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])])
    const result = await readCapped(stream, 100)
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
  })

  it('allows a total exactly at the cap', async () => {
    const stream = streamOf([new Uint8Array([1, 2, 3])])
    const result = await readCapped(stream, 3)
    expect(result).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('returns null and does not buffer past the cap', async () => {
    const stream = streamOf([new Uint8Array(10), new Uint8Array(10)])
    const result = await readCapped(stream, 15)
    expect(result).toBeNull()
  })

  it('rejects a real-sized favicon over MAX_FAVICON_BYTES', async () => {
    const stream = streamOf([new Uint8Array(MAX_FAVICON_BYTES + 1)])
    const result = await readCapped(stream, MAX_FAVICON_BYTES)
    expect(result).toBeNull()
  })
})

describe('toDataUrl', () => {
  it('builds a data: URL for an allowed type', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const url = toDataUrl(bytes, 'image/png')
    expect(url).toBe(`data:image/png;base64,${Buffer.from(bytes).toString('base64')}`)
  })

  it('is case-insensitive and strips a charset parameter', () => {
    const bytes = new Uint8Array([1])
    expect(toDataUrl(bytes, 'IMAGE/PNG')).toContain('data:image/png;base64,')
    expect(toDataUrl(bytes, 'image/gif; charset=binary')).toContain('data:image/gif;base64,')
  })

  it('rejects an unknown or missing content type', () => {
    const bytes = new Uint8Array([1])
    expect(toDataUrl(bytes, 'text/html')).toBeNull()
    expect(toDataUrl(bytes, null)).toBeNull()
  })

  // Security-relevant: SVG is deliberately not on the allowlist (see the
  // module header) even though it is a plausible favicon format.
  it('rejects image/svg+xml even though it is a real favicon MIME type', () => {
    expect(toDataUrl(new Uint8Array([1]), 'image/svg+xml')).toBeNull()
  })
})

describe('shouldClearFavicon', () => {
  it('does nothing when nothing has been captured yet', () => {
    expect(shouldClearFavicon(null, 'https://a.example/page2')).toBe(false)
  })

  it('does not clear on a same-origin navigation', () => {
    expect(shouldClearFavicon('https://a.example', 'https://a.example/page2')).toBe(false)
  })

  it('clears on a cross-origin navigation', () => {
    expect(shouldClearFavicon('https://a.example', 'https://b.example/')).toBe(true)
  })

  // Different scheme or port is a different origin even with the same
  // hostname -- URL.origin already encodes this, exercised here so a
  // future refactor away from URL.origin doesn't silently drop it.
  it('treats a different scheme or port as a different origin', () => {
    expect(shouldClearFavicon('https://a.example', 'http://a.example/')).toBe(true)
    expect(shouldClearFavicon('https://a.example:443', 'https://a.example:8443/')).toBe(true)
  })

  // about:blank does not throw -- URL('about:blank').origin is the
  // literal string "null", which simply compares unequal below.
  it('clears when navigating to about:blank', () => {
    expect(shouldClearFavicon('https://a.example', 'about:blank')).toBe(true)
  })

  it('clears for a string that is not a parseable URL at all', () => {
    expect(shouldClearFavicon('https://a.example', 'not a url')).toBe(true)
  })
})
