import { describe, expect, it, vi } from 'vitest'

// fetchFaviconDataUrl dynamically imports 'electron' for net.fetch (see
// favicon.ts's file header for why) -- mocked here so the F35 regression
// test below can hand it a response whose body errors mid-read without a
// real network call.
vi.mock('electron', () => ({
  net: { fetch: vi.fn() }
}))

const { net } = await import('electron')
const {
  MAX_FAVICON_BYTES,
  fetchFaviconDataUrl,
  pickFaviconUrl,
  readCapped,
  shouldClearFavicon,
  toDataUrl
} = await import('../favicon.js')

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

// F35: a server that replies 200 OK with a declared Content-Length and then
// closes the socket errors Chromium's body stream mid-read, so
// reader.read() rejects on some later call rather than the stream simply
// ending. streamOf() above can only ever produce a clean close, so this
// models the failure shape that actually reached production.
function erroringStream (): ReadableStream<Uint8Array> {
  let delivered = false
  return new ReadableStream({
    pull (controller) {
      if (!delivered) {
        delivered = true
        controller.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
        return
      }
      controller.error(new Error('simulated mid-body stream failure'))
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

  // F35: readCapped itself still propagates a mid-read stream error as a
  // rejection -- fetchFaviconDataUrl's own describe block below is what
  // asserts the caller catches it. This test documents the precondition
  // that fix depends on.
  it('rejects when the underlying stream errors mid-read', async () => {
    await expect(readCapped(erroringStream(), MAX_FAVICON_BYTES)).rejects.toThrow()
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

describe('fetchFaviconDataUrl', () => {
  // F35 (CLAUDE-SECURITY-20260910-203341): a favicon host that truncates
  // its body against a declared Content-Length errors the response stream
  // mid-read. Before the fix, that rejection escaped this function despite
  // its own doc comment promising it never throws -- and tabs.ts's bare
  // `void` turned it into an unhandled rejection that this codebase maps
  // to app.exit(1), killing every open tab. This asserts the contract
  // actually holds now.
  it('resolves null, not a rejection, when the response body errors mid-read', async () => {
    vi.mocked(net.fetch).mockResolvedValue({
      ok: true,
      body: erroringStream(),
      headers: { get: () => 'image/png' }
    } as never)

    await expect(fetchFaviconDataUrl('https://attacker.example/boom.png')).resolves.toBeNull()
  })
})
