import { describe, expect, it, vi } from 'vitest'
import type { Resolver } from '../../broker/policy/connect.js'

// fetchFaviconDataUrl dynamically imports 'electron' for net.fetch (see
// favicon.ts's file header for why) -- mocked here so the F35 regression
// test below can hand it a response whose body errors mid-read without a
// real network call. That mock is also why every symbol below arrives
// through a dynamic import rather than a static one: it has to be
// registered before favicon.js is evaluated.
vi.mock('electron', () => ({
  net: { fetch: vi.fn() }
}))

const { net } = await import('electron')
const {
  MAX_FAVICON_BYTES,
  fetchFaviconDataUrl,
  isSafeFaviconUrl,
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

/** Fails the test if called -- proves a literal-address candidate never reaches resolution. */
const unreachableResolver: Resolver = async () => {
  throw new Error('resolveHost must not be called for a literal address')
}

function resolverReturning (...addresses: string[]): Resolver {
  return async () => addresses
}

// T12 (security-model.md): every case from the brief's own test list, plus
// the scheme and localhost restrictions layered on top of it.
describe('isSafeFaviconUrl', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['::1', 'loopback, IPv6'],
    ['10.0.0.1', 'RFC 1918'],
    ['172.16.0.1', 'RFC 1918, 172.16-31 range'],
    ['192.168.1.1', 'RFC 1918'],
    ['169.254.169.254', 'link-local / cloud metadata'],
    ['0.0.0.0', 'unspecified'],
    ['2130706433', 'loopback as one decimal integer'],
    ['0177.0.0.1', 'loopback with an octal first octet'],
    ['0x7f000001', 'loopback as one hex integer'],
    ['::ffff:127.0.0.1', 'IPv4-mapped IPv6 loopback -- the classic bypass']
  ])('refuses a literal %s (%s) without ever resolving', async (literal) => {
    await expect(isSafeFaviconUrl(`https://${literal}/icon.png`, unreachableResolver)).resolves.toBe(false)
  })

  it('refuses a hostname that resolves to a private address', async () => {
    await expect(isSafeFaviconUrl('https://rebind.example/icon.png', resolverReturning('127.0.0.1')))
      .resolves.toBe(false)
  })

  it('refuses a hostname where only ONE of several resolved addresses is private', async () => {
    await expect(
      isSafeFaviconUrl('https://rebind.example/icon.png', resolverReturning('93.184.216.34', '127.0.0.1'))
    ).resolves.toBe(false)
  })

  it('refuses a hostname that resolves to no addresses', async () => {
    await expect(isSafeFaviconUrl('https://nowhere.example/icon.png', resolverReturning()))
      .resolves.toBe(false)
  })

  it('refuses a hostname whose resolution throws', async () => {
    const throwing: Resolver = async () => { throw new Error('NXDOMAIN') }
    await expect(isSafeFaviconUrl('https://nowhere.example/icon.png', throwing)).resolves.toBe(false)
  })

  it('refuses http:// even for an otherwise-public host', async () => {
    await expect(isSafeFaviconUrl('http://93.184.216.34/icon.png', unreachableResolver)).resolves.toBe(false)
  })

  it('refuses the .localhost namespace without ever resolving (RFC 6761)', async () => {
    await expect(isSafeFaviconUrl('https://localhost/icon.png', unreachableResolver)).resolves.toBe(false)
    await expect(isSafeFaviconUrl('https://app.localhost/icon.png', unreachableResolver)).resolves.toBe(false)
  })

  it('refuses a string that does not parse as a URL', async () => {
    await expect(isSafeFaviconUrl('not a url', unreachableResolver)).resolves.toBe(false)
  })

  it('accepts an ordinary public literal address without resolving', async () => {
    await expect(isSafeFaviconUrl('https://93.184.216.34/icon.png', unreachableResolver)).resolves.toBe(true)
  })

  it('accepts an ordinary public hostname once every resolved address is public', async () => {
    await expect(
      isSafeFaviconUrl('https://example.com/icon.png', resolverReturning('93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'))
    ).resolves.toBe(true)
  })
})

describe('fetchFaviconDataUrl', () => {
  // Every literal case is denied inside isSafeFaviconUrl before this
  // function ever reaches its `import('electron')` line, so these run
  // safely under plain vitest -- no Electron mock needed, and the
  // resolution never happens for a literal address.
  it.each([
    '127.0.0.1',
    '::1',
    '169.254.169.254',
    '2130706433'
  ])('never fetches a favicon at the literal address %s', async (literal) => {
    await expect(fetchFaviconDataUrl(`https://${literal}/icon.png`)).resolves.toBeNull()
  })

  it('never fetches an http:// favicon candidate', async () => {
    await expect(fetchFaviconDataUrl('http://93.184.216.34/icon.png')).resolves.toBeNull()
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
