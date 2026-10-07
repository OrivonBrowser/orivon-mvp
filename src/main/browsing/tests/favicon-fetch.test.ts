import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Resolver } from '../../../broker/policy/connect.js'
import { MAX_FAVICON_BYTES } from '../favicon-format.js'
import { FAVICON_TIMEOUT_MS, faviconTimeoutMs, VERIFIED_FAVICON_TIMEOUT_MS } from '../favicon-timeout.js'

// fetchFaviconDataUrlCached dynamically imports 'electron' for net.request (see
// favicon-fetch.ts's file header for why net.request, not net.fetch) -- mocked
// here so every network-touching test below can hand it a scripted
// response without a real network call. That mock is also why every symbol
// below arrives through a dynamic import rather than a static one: it has
// to be registered before favicon-fetch.js is evaluated.
vi.mock('electron', () => ({
  net: { request: vi.fn() }
}))

const { net } = await import('electron')
const { fetchFaviconDataUrlCached, isSafeFaviconUrl, MAX_FAVICON_REDIRECTS, readCapped } = await import('../favicon-fetch.js')
const { fakeIncomingMessage, mockRequestOnce, PNG_BYTES, PUBLIC_PAGE, requests, respondOk } = await import('./favicon.test-helpers.js')

/** The network path, with nothing it fetches kept: every call below that
 * clears the gate reaches net.request. */
async function fetchUncached (url: string, pageUrl: string): Promise<string | null> {
  return await fetchFaviconDataUrlCached(url, pageUrl, () => false)
}

// net.request is one shared mock across the whole file (the module-level
// `const { net }` above), so a call recorded in one test would otherwise
// still be there for the next -- every test that asserts on it starts clean.
beforeEach(() => {
  vi.mocked(net.request).mockReset()
  requests.length = 0
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
/** A page on loopback, against which a loopback candidate is judged; PUBLIC_PAGE is the public one. */
const LOCAL_PAGE = 'http://127.0.0.1:3000/app'

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
  ])('refuses a literal %s (%s) to a PUBLIC page, without ever resolving', async (literal) => {
    await expect(isSafeFaviconUrl(`https://${literal}/icon.png`, PUBLIC_PAGE, unreachableResolver)).resolves.toBe(false)
  })

  it('refuses a hostname that resolves to a private address', async () => {
    await expect(isSafeFaviconUrl('https://rebind.example/icon.png', PUBLIC_PAGE, resolverReturning('127.0.0.1')))
      .resolves.toBe(false)
  })

  it('refuses a hostname where only ONE of several resolved addresses is private', async () => {
    await expect(
      isSafeFaviconUrl('https://rebind.example/icon.png', PUBLIC_PAGE, resolverReturning('93.184.216.34', '127.0.0.1'))
    ).resolves.toBe(false)
  })

  it('refuses a hostname that resolves to no addresses', async () => {
    await expect(isSafeFaviconUrl('https://nowhere.example/icon.png', PUBLIC_PAGE, resolverReturning()))
      .resolves.toBe(false)
  })

  it('refuses a hostname whose resolution throws', async () => {
    const throwing: Resolver = async () => { throw new Error('NXDOMAIN') }
    await expect(isSafeFaviconUrl('https://nowhere.example/icon.png', PUBLIC_PAGE, throwing)).resolves.toBe(false)
  })

  it('refuses http:// even for an otherwise-public host', async () => {
    await expect(isSafeFaviconUrl('http://93.184.216.34/icon.png', PUBLIC_PAGE, unreachableResolver)).resolves.toBe(false)
  })

  it('refuses the .localhost namespace to a PUBLIC page without ever resolving (RFC 6761)', async () => {
    await expect(isSafeFaviconUrl('https://localhost/icon.png', PUBLIC_PAGE, unreachableResolver)).resolves.toBe(false)
    await expect(isSafeFaviconUrl('https://app.localhost/icon.png', PUBLIC_PAGE, unreachableResolver)).resolves.toBe(false)
  })

  it('refuses a string that does not parse as a URL', async () => {
    await expect(isSafeFaviconUrl('not a url', PUBLIC_PAGE, unreachableResolver)).resolves.toBe(false)
  })

  it('accepts an ordinary public literal address without resolving', async () => {
    await expect(isSafeFaviconUrl('https://93.184.216.34/icon.png', PUBLIC_PAGE, unreachableResolver)).resolves.toBe(true)
  })

  it('accepts an ordinary public hostname once every resolved address is public', async () => {
    await expect(
      isSafeFaviconUrl('https://example.com/icon.png', PUBLIC_PAGE, resolverReturning('93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'))
    ).resolves.toBe(true)
  })
})

// A local dev server's icon is a real thing to want. What the allowance turns
// on is WHICH PAGE is asking -- the page fully controls the favicon URL, so a
// public page pointing at loopback is a port scanner driven from the main
// process, not an icon belonging to a local site.
describe('isSafeFaviconUrl -- loopback, for a page that is itself on loopback', () => {
  it.each([
    'http://127.0.0.1:3000/favicon.ico',
    'http://localhost:3000/favicon.ico',
    'http://[::1]:3000/favicon.ico',
    'https://127.0.0.1:3000/favicon.ico',
    'http://app.localhost/favicon.ico'
  ])('accepts %s when the page is local', async (candidate) => {
    await expect(isSafeFaviconUrl(candidate, LOCAL_PAGE, unreachableResolver)).resolves.toBe(true)
  })

  it('accepts http, which is the whole point -- a dev server is almost never https', async () => {
    await expect(isSafeFaviconUrl('http://127.0.0.1:8080/icon.png', LOCAL_PAGE, unreachableResolver))
      .resolves.toBe(true)
  })

  it('still refuses loopback to a PUBLIC page -- that is a port scan, not an icon', async () => {
    await expect(isSafeFaviconUrl('http://127.0.0.1:8080/icon.png', PUBLIC_PAGE, unreachableResolver))
      .resolves.toBe(false)
    await expect(isSafeFaviconUrl('https://localhost/icon.png', PUBLIC_PAGE, unreachableResolver))
      .resolves.toBe(false)
  })

  it('refuses every obfuscated loopback spelling to a public page too', async () => {
    for (const literal of ['0177.0.0.1', '0x7f000001', '2130706433', '::ffff:127.0.0.1']) {
      await expect(isSafeFaviconUrl(`http://${literal}/icon.png`, PUBLIC_PAGE, unreachableResolver))
        .resolves.toBe(false)
    }
  })

  it('accepts those same spellings FROM a local page -- they are the same machine either way', async () => {
    for (const literal of ['0177.0.0.1', '0x7f000001', '2130706433']) {
      await expect(isSafeFaviconUrl(`http://${literal}/icon.png`, LOCAL_PAGE, unreachableResolver))
        .resolves.toBe(true)
    }
  })

  it('does not treat a file: page as local -- a downloaded HTML file must not be the lever', async () => {
    await expect(isSafeFaviconUrl('http://127.0.0.1:8080/icon.png', 'file:///tmp/evil.html', unreachableResolver))
      .resolves.toBe(false)
  })

  it('does not treat an unparseable page URL as local', async () => {
    await expect(isSafeFaviconUrl('http://127.0.0.1:8080/icon.png', '', unreachableResolver))
      .resolves.toBe(false)
  })

  it('does not let a local page reach a PRIVATE LAN address -- only this machine', async () => {
    await expect(isSafeFaviconUrl('http://192.168.1.1/icon.png', LOCAL_PAGE, unreachableResolver))
      .resolves.toBe(false)
    await expect(isSafeFaviconUrl('http://169.254.169.254/icon.png', LOCAL_PAGE, unreachableResolver))
      .resolves.toBe(false)
  })

  it('does not let a local page force plaintext off-machine either', async () => {
    await expect(isSafeFaviconUrl('http://93.184.216.34/icon.png', LOCAL_PAGE, unreachableResolver))
      .resolves.toBe(false)
  })

  it('refuses a non-http(s) scheme on loopback', async () => {
    await expect(isSafeFaviconUrl('file:///etc/passwd', LOCAL_PAGE, unreachableResolver)).resolves.toBe(false)
  })
})

// An app origin that is neither a localhost name nor public unicast -- the
// session-scoped plain-http host a dev grant steers at 127.0.0.1 by a fake
// `.eth` name -- would otherwise never show its own icon: the classification
// below the carve-out is about cross-origin reaches, and a same-origin
// nomination invents none.
describe('isSafeFaviconUrl -- same origin with the page that declared it', () => {
  const APP_PAGE = 'http://bisq.eth:8885/index.html'

  it('accepts a candidate on the app page\'s own origin, without ever resolving', async () => {
    await expect(isSafeFaviconUrl('http://bisq.eth:8885/bisq.ico', APP_PAGE, unreachableResolver))
      .resolves.toBe(true)
  })

  it('accepts a same-origin candidate on a subpath too', async () => {
    await expect(isSafeFaviconUrl('http://bisq.eth:8885/img/icon.ico', APP_PAGE, unreachableResolver))
      .resolves.toBe(true)
  })

  it('accepts a same-origin candidate for a public https page the same way', async () => {
    await expect(isSafeFaviconUrl('https://example.com/favicon.ico', PUBLIC_PAGE, unreachableResolver))
      .resolves.toBe(true)
  })

  it('refuses a cross-origin candidate on a DIFFERENT port -- the carve-out is per origin', async () => {
    await expect(isSafeFaviconUrl('http://bisq.eth:9999/icon.png', APP_PAGE, unreachableResolver))
      .resolves.toBe(false)
  })

  it('refuses an https candidate for an http page -- different origin, not a mixed-content bypass', async () => {
    await expect(isSafeFaviconUrl('http://example.com/icon.png', 'https://example.com/page', unreachableResolver))
      .resolves.toBe(false)
    await expect(isSafeFaviconUrl('https://example.com/icon.png', 'http://example.com/page', unreachableResolver))
      .resolves.toBe(false)
  })

  it('does not match two opaque origins -- a file: candidate cannot ride a file: page', async () => {
    await expect(isSafeFaviconUrl('file:///etc/passwd', 'file:///tmp/evil.html', unreachableResolver))
      .resolves.toBe(false)
  })

  it('does not treat an unparseable page URL as same origin', async () => {
    await expect(isSafeFaviconUrl('http://127.0.0.1:8080/icon.png', '', unreachableResolver))
      .resolves.toBe(false)
  })
})

describe('fetchFaviconDataUrlCached -- T12 refusals never reach the network', () => {
  // Every literal case is denied inside isSafeFaviconUrl before this
  // function ever reaches its `import('electron')` line, so these run
  // safely under plain vitest -- no Electron mock needed, and the
  // resolution never happens for a literal address.
  it.each([
    '127.0.0.1',
    '::1',
    '169.254.169.254',
    '2130706433'
  ])('never fetches a favicon at the literal address %s for a public page', async (literal) => {
    await expect(fetchUncached(`https://${literal}/icon.png`, PUBLIC_PAGE)).resolves.toBeNull()
  })

  it('never fetches an http:// favicon candidate off loopback', async () => {
    await expect(fetchUncached('http://93.184.216.34/icon.png', PUBLIC_PAGE)).resolves.toBeNull()
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

describe('faviconTimeoutMs', () => {
  it('gives a host the verifier serves, whose content is checked block by block, longer than an ordinary host', () => {
    for (const url of ['https://bafybeigy2kmabi5bwda52cjjpsxlfs46fp4i6j4hfi76dgiz3n6qvt6ppm.ipfs.orivon/a/icon.png', 'https://vitalik.eth/favicon.ico', 'https://docs.example.ipns.orivon/x.png']) {
      expect(faviconTimeoutMs(url), url).toBe(VERIFIED_FAVICON_TIMEOUT_MS)
    }
    expect(VERIFIED_FAVICON_TIMEOUT_MS).toBeGreaterThan(FAVICON_TIMEOUT_MS)
  })

  it('keeps the short budget for every other host, and for what is not a URL', () => {
    for (const url of ['https://example.com/favicon.ico', 'http://127.0.0.1:8080/icon.png', 'https://eth.example.com/icon.png', 'https://ipfs.orivon.example/icon.png', 'not a url']) {
      expect(faviconTimeoutMs(url), url).toBe(FAVICON_TIMEOUT_MS)
    }
  })
})

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
  // rejection -- the net.request-driven tests below assert the caller
  // catches it. This test documents the precondition that fix depends on.
  it('rejects when the underlying stream errors mid-read', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start (controller) { controller.enqueue(new Uint8Array([1, 2, 3])) },
      pull (controller) { controller.error(new Error('simulated mid-body stream failure')) }
    })
    await expect(readCapped(stream, MAX_FAVICON_BYTES)).rejects.toThrow()
  })
})

describe('fetchFaviconDataUrlCached -- over net.request', () => {
  it('decodes a plain 200 response, typed from its bytes', async () => {
    mockRequestOnce((request) => { request.emit('response', respondOk(200, [PNG_BYTES])) })
    await expect(fetchUncached('https://93.184.216.34/icon.png', PUBLIC_PAGE))
      .resolves.toBe(`data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`)
  })

  it('treats a non-2xx status as a failure', async () => {
    mockRequestOnce((request) => { request.emit('response', respondOk(404, [])) })
    await expect(fetchUncached('https://93.184.216.34/icon.png', PUBLIC_PAGE)).resolves.toBeNull()
  })

  it('follows a redirect whose target still clears T12, and stops re-requesting once it does', async () => {
    mockRequestOnce((request) => { request.emit('redirect', 301, 'GET', 'https://93.184.216.35/icon.png', {}) })
    mockRequestOnce((request) => { request.emit('response', respondOk(200, [PNG_BYTES])) })
    await expect(fetchUncached('https://93.184.216.34/icon.png', PUBLIC_PAGE))
      .resolves.toBe(`data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`)
    expect(net.request).toHaveBeenCalledTimes(2)
  })

  it('refuses a redirect to loopback from a public page, without a second request', async () => {
    mockRequestOnce((request) => { request.emit('redirect', 302, 'GET', 'http://127.0.0.1:8080/icon.png', {}) })
    await expect(fetchUncached('https://93.184.216.34/icon.png', PUBLIC_PAGE)).resolves.toBeNull()
    expect(net.request).toHaveBeenCalledTimes(1)
  })

  it('gives up after MAX_FAVICON_REDIRECTS redirects', async () => {
    for (let hop = 0; hop <= MAX_FAVICON_REDIRECTS; hop++) {
      mockRequestOnce((request) => { request.emit('redirect', 301, 'GET', `https://93.184.216.34/hop${String(hop)}`, {}) })
    }
    await expect(fetchUncached('https://93.184.216.34/icon.png', PUBLIC_PAGE)).resolves.toBeNull()
    expect(net.request).toHaveBeenCalledTimes(MAX_FAVICON_REDIRECTS + 1)
  })

  // F35 (CLAUDE-SECURITY-20260910-203341): a favicon host that truncates its
  // body against a declared Content-Length errors the response stream
  // mid-read. Before the fix, that rejection escaped this function despite
  // its own doc comment promising it never throws -- and tabs.ts's bare
  // `void` turned it into an unhandled rejection that this codebase maps to
  // app.exit(1), killing every open tab. This asserts the contract still
  // holds against the net.request-based fetch.
  it('resolves null, not a rejection, when the response body errors mid-read', async () => {
    mockRequestOnce((request) => {
      const stream = fakeIncomingMessage(200)
      request.emit('response', stream)
      stream.push(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))
      queueMicrotask(() => { stream.destroy(new Error('simulated mid-body stream failure')) })
    })
    await expect(fetchUncached('https://93.184.216.34/boom.png', PUBLIC_PAGE)).resolves.toBeNull()
  })

  it('resolves null, not a rejection, on a transport error', async () => {
    mockRequestOnce((request) => { request.emit('error', new Error('ECONNRESET')) })
    await expect(fetchUncached('https://93.184.216.34/icon.png', PUBLIC_PAGE)).resolves.toBeNull()
  })
})

// Electron's loader stays alive until it completes or is cancelled, and
// nobody reads a failed hop's body, so a failure that is not aborted holds
// a socket from the default session's pool until the server gives up.
describe('fetchFaviconDataUrlCached -- a failed hop aborts its request', () => {
  it('aborts a 404 whose body is never read', async () => {
    mockRequestOnce((request) => {
      const body = fakeIncomingMessage(404)
      body.push(Buffer.from('<html>not found</html>'))
      request.emit('response', body)
    })
    await expect(fetchUncached('https://93.184.216.34/missing.ico', PUBLIC_PAGE)).resolves.toBeNull()
    expect(requests[0]?.abort).toHaveBeenCalled()
  })

  it('aborts a body past MAX_FAVICON_BYTES', async () => {
    mockRequestOnce((request) => {
      const body = fakeIncomingMessage(200)
      const oversized = new Uint8Array(MAX_FAVICON_BYTES + 1)
      oversized.set(PNG_BYTES)
      body.push(Buffer.from(oversized))
      request.emit('response', body)
    })
    await expect(fetchUncached('https://93.184.216.34/huge.png', PUBLIC_PAGE)).resolves.toBeNull()
    expect(requests[0]?.abort).toHaveBeenCalled()
  })

  it('aborts a body that errors mid-read', async () => {
    mockRequestOnce((request) => {
      const body = fakeIncomingMessage(200)
      request.emit('response', body)
      body.push(Buffer.from([1, 2, 3]))
      queueMicrotask(() => { body.destroy(new Error('simulated mid-body stream failure')) })
    })
    await expect(fetchUncached('https://93.184.216.34/broken.png', PUBLIC_PAGE)).resolves.toBeNull()
    expect(requests[0]?.abort).toHaveBeenCalled()
  })

  it('does not abort a request that completed', async () => {
    mockRequestOnce((request) => { request.emit('response', respondOk(200, [PNG_BYTES])) })
    await expect(fetchUncached('https://93.184.216.34/whole.png', PUBLIC_PAGE)).resolves.not.toBeNull()
    expect(requests[0]?.abort).not.toHaveBeenCalled()
  })
})
