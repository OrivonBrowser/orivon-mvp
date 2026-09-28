import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Resolver } from '../../../broker/policy/connect.js'
import type { FaviconTarget } from '../favicon.js'

// fetchFaviconDataUrl dynamically imports 'electron' for net.request (see
// favicon.ts's file header for why net.request, not net.fetch) -- mocked
// here so every network-touching test below can hand it a scripted
// response without a real network call. That mock is also why every symbol
// below arrives through a dynamic import rather than a static one: it has
// to be registered before favicon.js is evaluated.
vi.mock('electron', () => ({
  net: { request: vi.fn() }
}))

const { net } = await import('electron')
const {
  MAX_FAVICON_BYTES,
  MAX_FAVICON_CANDIDATES,
  MAX_FAVICON_REDIRECTS,
  captureFaviconInto,
  faviconCandidates,
  fetchFaviconDataUrl,
  isSafeFaviconUrl,
  readCapped,
  shouldClearFavicon,
  toDataUrl
} = await import('../favicon.js')

// net.request is one shared mock across the whole file (the module-level
// `const { net }` above), so a call recorded in one test would otherwise
// still be there for the next -- every test that asserts on it starts clean.
beforeEach(() => {
  vi.mocked(net.request).mockReset()
})

describe('faviconCandidates', () => {
  it('returns an empty list for an empty list', () => {
    expect(faviconCandidates([])).toEqual([])
  })

  it('keeps http(s) candidates, in order', () => {
    expect(faviconCandidates(['https://a.example/icon.png', 'http://b.example/icon.png']))
      .toEqual(['https://a.example/icon.png', 'http://b.example/icon.png'])
  })

  it('keeps a data: candidate too', () => {
    expect(faviconCandidates(['data:image/png;base64,AAA=', 'https://a.example/icon.png']))
      .toEqual(['data:image/png;base64,AAA=', 'https://a.example/icon.png'])
  })

  it('drops anything that is not http(s) or data:', () => {
    expect(faviconCandidates(['javascript:alert(1)', 'https://a.example/icon.png']))
      .toEqual(['https://a.example/icon.png'])
  })

  it('returns an empty list when nothing qualifies', () => {
    expect(faviconCandidates(['javascript:alert(1)', 'blob:whatever'])).toEqual([])
  })

  it('caps at MAX_FAVICON_CANDIDATES', () => {
    const many = Array.from({ length: MAX_FAVICON_CANDIDATES + 5 }, (_, i) => `https://a.example/${String(i)}.png`)
    expect(faviconCandidates(many)).toHaveLength(MAX_FAVICON_CANDIDATES)
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
/** The page declaring the icon. Loopback candidates are judged against this
 * (owner, 2026-09-16), so every case has to say which kind of page is asking. */
const PUBLIC_PAGE = 'https://example.com/page'
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

// Owner's decision, 2026-09-16: a local dev server's icon is a real thing to
// want, and refusing it bought nothing. What the allowance turns on is WHICH
// PAGE is asking -- the page fully controls the favicon URL, so a public page
// pointing at loopback is a port scanner driven from the main process, not an
// icon belonging to a local site.
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

describe('fetchFaviconDataUrl -- T12 refusals never reach the network', () => {
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
    await expect(fetchFaviconDataUrl(`https://${literal}/icon.png`, PUBLIC_PAGE)).resolves.toBeNull()
  })

  it('never fetches an http:// favicon candidate off loopback', async () => {
    await expect(fetchFaviconDataUrl('http://93.184.216.34/icon.png', PUBLIC_PAGE)).resolves.toBeNull()
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

describe('toDataUrl', () => {
  it('builds a data: URL, typed from the bytes, for a PNG', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])
    expect(toDataUrl(bytes)).toBe(`data:image/png;base64,${Buffer.from(bytes).toString('base64')}`)
  })

  it('builds a data: URL for a real SVG document -- no longer excluded', () => {
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

// --- net.request harness, for fetchFaviconDataUrl/captureFaviconInto's own network path ---

interface FakeClientRequest extends EventEmitter {
  end: () => void
  abort: () => void
}

function fakeClientRequest (): FakeClientRequest {
  const emitter = new EventEmitter() as FakeClientRequest
  emitter.end = vi.fn()
  emitter.abort = vi.fn(() => { emitter.emit('error', new Error('aborted')) })
  return emitter
}

function fakeIncomingMessage (statusCode: number): Readable & { statusCode: number } {
  const stream = new Readable({ read () {} }) as Readable & { statusCode: number }
  stream.statusCode = statusCode
  return stream
}

/** Queues one `net.request(...)` call's whole behaviour. Deferred to a
 * microtask so it fires only once requestOnce's own synchronous listener
 * registration (three `.on(...)` calls, then `.end()`) has already run --
 * none of that registration ever awaits, so a plain microtask is enough. */
function mockRequestOnce (act: (request: FakeClientRequest) => void): void {
  vi.mocked(net.request).mockImplementationOnce(() => {
    const request = fakeClientRequest()
    queueMicrotask(() => { act(request) })
    return request as never
  })
}

function respondOk (statusCode: number, chunks: Uint8Array[]): Readable & { statusCode: number } {
  const stream = fakeIncomingMessage(statusCode)
  for (const chunk of chunks) stream.push(Buffer.from(chunk))
  stream.push(null)
  return stream
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

describe('fetchFaviconDataUrl -- over net.request', () => {
  it('decodes a plain 200 response, typed from its bytes', async () => {
    mockRequestOnce((request) => { request.emit('response', respondOk(200, [PNG_BYTES])) })
    await expect(fetchFaviconDataUrl('https://93.184.216.34/icon.png', PUBLIC_PAGE))
      .resolves.toBe(`data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`)
  })

  it('treats a non-2xx status as a failure', async () => {
    mockRequestOnce((request) => { request.emit('response', respondOk(404, [])) })
    await expect(fetchFaviconDataUrl('https://93.184.216.34/icon.png', PUBLIC_PAGE)).resolves.toBeNull()
  })

  it('follows a redirect whose target still clears T12, and stops re-requesting once it does', async () => {
    mockRequestOnce((request) => { request.emit('redirect', 301, 'GET', 'https://93.184.216.35/icon.png', {}) })
    mockRequestOnce((request) => { request.emit('response', respondOk(200, [PNG_BYTES])) })
    await expect(fetchFaviconDataUrl('https://93.184.216.34/icon.png', PUBLIC_PAGE))
      .resolves.toBe(`data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`)
    expect(net.request).toHaveBeenCalledTimes(2)
  })

  it('refuses a redirect to loopback from a public page, without a second request', async () => {
    mockRequestOnce((request) => { request.emit('redirect', 302, 'GET', 'http://127.0.0.1:8080/icon.png', {}) })
    await expect(fetchFaviconDataUrl('https://93.184.216.34/icon.png', PUBLIC_PAGE)).resolves.toBeNull()
    expect(net.request).toHaveBeenCalledTimes(1)
  })

  it('gives up after MAX_FAVICON_REDIRECTS redirects', async () => {
    for (let hop = 0; hop <= MAX_FAVICON_REDIRECTS; hop++) {
      mockRequestOnce((request) => { request.emit('redirect', 301, 'GET', `https://93.184.216.34/hop${String(hop)}`, {}) })
    }
    await expect(fetchFaviconDataUrl('https://93.184.216.34/icon.png', PUBLIC_PAGE)).resolves.toBeNull()
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
    await expect(fetchFaviconDataUrl('https://93.184.216.34/boom.png', PUBLIC_PAGE)).resolves.toBeNull()
  })

  it('resolves null, not a rejection, on a transport error', async () => {
    mockRequestOnce((request) => { request.emit('error', new Error('ECONNRESET')) })
    await expect(fetchFaviconDataUrl('https://93.184.216.34/icon.png', PUBLIC_PAGE)).resolves.toBeNull()
  })
})

describe('captureFaviconInto', () => {
  function makeTarget (): FaviconTarget {
    return { favicon: null, faviconOrigin: null, pendingFaviconUrl: null }
  }

  it('decodes a data: candidate locally, with no network reach at all', async () => {
    const svg = '<svg></svg>'
    const dataUrl = `data:image/svg+xml,${encodeURIComponent(svg)}`
    const target = makeTarget()
    let updated = false

    await captureFaviconInto(target, [dataUrl], () => PUBLIC_PAGE, () => true, () => { updated = true })

    expect(net.request).not.toHaveBeenCalled()
    expect(target.favicon).toBe(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
    expect(updated).toBe(true)
  })

  it('falls through to the next candidate once the first fails to decode', async () => {
    mockRequestOnce((request) => { request.emit('error', new Error('refused')) })
    mockRequestOnce((request) => { request.emit('response', respondOk(200, [PNG_BYTES])) })
    const target = makeTarget()

    await captureFaviconInto(
      target,
      ['https://93.184.216.34/bad.ico', 'https://93.184.216.34/good.png'],
      () => PUBLIC_PAGE,
      () => true,
      () => {}
    )

    expect(target.favicon).toBe(`data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`)
  })

  it('never writes anything once every candidate has failed', async () => {
    mockRequestOnce((request) => { request.emit('error', new Error('refused')) })
    const target = makeTarget()
    let updated = false

    await captureFaviconInto(target, ['https://93.184.216.34/bad.ico'], () => PUBLIC_PAGE, () => true, () => { updated = true })

    expect(target.favicon).toBeNull()
    expect(updated).toBe(false)
  })

  // The bug this fixes: favicon.ts used to record the ICON's own origin
  // (here, a CDN host different from the page), which shouldClearFavicon
  // then compared against the PAGE's origin on every navigation -- so an
  // icon hosted off-origin was cleared on the very next same-origin
  // navigation and never came back (page-favicon-updated does not refire
  // for an unchanged icon set).
  it('records the DECLARING PAGE\'s origin, not the icon resource\'s own origin', async () => {
    mockRequestOnce((request) => { request.emit('response', respondOk(200, [PNG_BYTES])) })
    const target = makeTarget()
    const page = 'https://a.example/page'

    // A public literal address, not a.example's own hostname -- a real CDN
    // icon, and a literal needs no DNS resolver mock to clear T12.
    await captureFaviconInto(target, ['https://93.184.216.34/icon.png'], () => page, () => true, () => {})

    expect(target.faviconOrigin).toBe('https://a.example')
    // The whole point of the fix: a same-origin navigation must not clear it.
    expect(shouldClearFavicon(target.faviconOrigin, 'https://a.example/page2')).toBe(false)
  })

  it('does nothing for an empty or all-unqualified candidate list', async () => {
    const target = makeTarget()
    await captureFaviconInto(target, [], () => PUBLIC_PAGE, () => true, () => {})
    await captureFaviconInto(target, ['javascript:alert(1)'], () => PUBLIC_PAGE, () => true, () => {})
    expect(net.request).not.toHaveBeenCalled()
    expect(target.favicon).toBeNull()
  })

  it('decodes an upper-case DATA: candidate locally too, never falling through to a network fetch', async () => {
    const target = makeTarget()
    await captureFaviconInto(target, ['DATA:image/png;base64,' + Buffer.from(PNG_BYTES).toString('base64')], () => PUBLIC_PAGE, () => true, () => {})
    expect(net.request).not.toHaveBeenCalled()
    expect(target.favicon).toBe(`data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`)
  })

  // The race three independent reviews of this diff converged on: a
  // sequential, multi-candidate loop with its own timeout and redirect
  // budget per candidate can still be running well after the tab has moved
  // on to a different page that never fired its own page-favicon-updated
  // (no icon, or an unchanged one) -- pendingFaviconUrl alone does not
  // catch that, since nothing overwrote it.
  it('never writes a favicon once the tab has navigated to a different page mid-fetch', async () => {
    let currentPage = 'https://a.example/page1'
    mockRequestOnce((request) => {
      // The tab commits a navigation while this request is still in flight.
      currentPage = 'https://b.example/page2'
      request.emit('response', respondOk(200, [PNG_BYTES]))
    })
    const target = makeTarget()
    let updated = false

    // A candidate URL no earlier test in this file used: faviconCache is
    // shared module state across every test, and a cache hit would skip
    // net.request entirely, exercising nothing this test exists to prove.
    await captureFaviconInto(target, ['https://93.184.216.99/race-icon.png'], () => currentPage, () => true, () => { updated = true })

    expect(target.favicon).toBeNull()
    expect(target.faviconOrigin).toBeNull()
    expect(updated).toBe(false)
  })
})
