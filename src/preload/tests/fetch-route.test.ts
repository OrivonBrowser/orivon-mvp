// Exercises the routed fetch the way a page meets it: every installer is
// re-evaluated from its own source (routed.test-helpers.ts's `reserialised`)
// and run against a plain fake `target` with a stub `orivon.net`, over the
// real platform ReadableStream/Response/Headers globals Node provides.
//
// `isAppTab` is passed explicitly and synchronously everywhere below --
// there is no `await` between installing and observing `target.fetch`, which
// is the regression test for an async gate that a page's first script could
// outrun.
import { deflateSync, gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { installFetchRoute } from '../fetch-route.js'
import type { FetchRouteTarget } from '../fetch-route.js'
import { ROUTED_MAX_HEAD_BYTES } from '../routed-wire.js'
import { OK_RESPONSE, bytes, concat, fakeSocket, fakeTarget, installRouted, refusal } from './routed.test-helpers.js'
import type { FakeSocket } from './routed.test-helpers.js'

/** A target whose https dials all answer `chunks`; `socket()` is the last one dialled. */
function secureTarget (chunks: () => Uint8Array[] = () => [OK_RESPONSE]): { target: FetchRouteTarget, socket: () => FakeSocket } {
  let last: FakeSocket | undefined
  const target = fakeTarget({ connectSecure: async () => { last = fakeSocket(chunks()); return last } })
  installRouted(target)
  return { target, socket: () => last! }
}

describe('installFetchRoute -- gating on isAppTab, synchronously', () => {
  it('installs the routed fetch IMMEDIATELY when isAppTab is true -- observable with no await at all', () => {
    const target = fakeTarget({})
    installRouted(target)
    expect(typeof target.fetch).toBe('function')
  })

  it('does nothing when isAppTab is false, even with a full orivon.net surface present', () => {
    const nativeFetch = async (): Promise<Response> => new Response('native')
    const target = fakeTarget({ nativeFetch })
    installFetchRoute(false, target)
    expect(target.fetch).toBe(nativeFetch)
  })

  it('installs the routed fetch under the descriptor the platform itself uses, so a page can replace it', () => {
    const target = fakeTarget({})
    installRouted(target)
    const descriptor = Object.getOwnPropertyDescriptor(target, 'fetch')
    expect(descriptor).toMatchObject({ writable: true, configurable: true, enumerable: true })
  })

  // cross-fetch's browser ponyfill builds a surrogate whose prototype IS the
  // window and shadows `fetch` on it. Shadowing a NON-WRITABLE inherited
  // data property is a TypeError in strict mode (ADR-0021).
  it('lets a page shadow the routed fetch on a surrogate global, as cross-fetch does', () => {
    const target = fakeTarget({})
    installRouted(target)
    function Surrogate (this: { fetch: unknown }): void { this.fetch = false }
    Surrogate.prototype = target
    expect(() => new (Surrogate as unknown as new () => unknown)()).not.toThrow()
  })

  it('does nothing when orivon.net is absent (no capability surface to route through)', () => {
    const target: FetchRouteTarget = {}
    expect(() => { installRouted(target) }).not.toThrow()
    expect(target.fetch).toBeUndefined()
  })

  it('leaves no shared slot behind on the page\'s window', () => {
    const target = fakeTarget({})
    installRouted(target)
    expect(Object.getOwnPropertySymbols(target)).toEqual([])
  })
})

describe('installFetchRoute -- routing decisions', () => {
  it('leaves a same-origin request to native fetch, unrouted', async () => {
    let netCalled = false
    const target = fakeTarget({
      connect: async () => { netCalled = true; return fakeSocket([]) },
      location: { origin: 'https://app.example', href: 'https://app.example/index.html' },
      nativeFetch: async () => new Response('same-origin bundle asset')
    })
    installRouted(target)
    const response = await target.fetch!('https://app.example/manifest.json')
    expect(await response.text()).toBe('same-origin bundle asset')
    expect(netCalled).toBe(false)
  })

  it('leaves data: and blob: URLs to native fetch', async () => {
    const seen: unknown[] = []
    const target = fakeTarget({ nativeFetch: async (input) => { seen.push(input); return new Response('native') } })
    installRouted(target)
    await target.fetch!('data:text/plain,hi')
    await target.fetch!('blob:https://app.example/1234')
    expect(seen).toEqual(['data:text/plain,hi', 'blob:https://app.example/1234'])
  })

  it('routes an http: request through net.connect and https: through net.connectSecure', async () => {
    const used: string[] = []
    const target = fakeTarget({
      connect: async () => { used.push('connect'); return fakeSocket([OK_RESPONSE]) },
      connectSecure: async () => { used.push('connectSecure'); return fakeSocket([OK_RESPONSE]) },
      location: { origin: 'https://app.example', href: 'https://app.example/' }
    })
    installRouted(target)
    await target.fetch!('http://api.example/x')
    await target.fetch!('https://api.example/x')
    expect(used).toEqual(['connect', 'connectSecure'])
  })

  it('hands a host the app was not granted to the page\'s native fetch, as an ordinary website would get', async () => {
    const nativeCalls: unknown[] = []
    const target = fakeTarget({
      connectSecure: async () => { throw refusal('denied') },
      nativeFetch: async (input, init) => { nativeCalls.push([input, init]); return new Response('from the native path') }
    })
    installRouted(target)
    const init = { method: 'POST', body: 'payload' }
    const response = await target.fetch!('https://not-granted.example/', init)
    expect(await response.text()).toBe('from the native path')
    expect(nativeCalls).toEqual([['https://not-granted.example/', init]])
  })

  it('keeps a Request\'s body unread for the native path when its host is not granted', async () => {
    let nativeBody: string | undefined
    const target = fakeTarget({
      connectSecure: async () => { throw refusal('denied') },
      nativeFetch: async (input) => { nativeBody = await (input as Request).text(); return new Response('') }
    })
    installRouted(target)
    await target.fetch!(new Request('https://not-granted.example/', { method: 'POST', body: 'intact' }))
    expect(nativeBody).toBe('intact')
  })

  it('fails like a real network error when the dial is refused for any other reason', async () => {
    const target = fakeTarget({ connectSecure: async () => { throw refusal('unreachable') } })
    installRouted(target)
    const error = await target.fetch!('https://down.example/').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TypeError)
    expect(error).toMatchObject({ message: 'Failed to fetch' })
  })

  it('names the platformCode of a failed dial in the error cause, and the Orivon code when there is none', async () => {
    const dead = fakeTarget({
      connectSecure: async () => { throw Object.assign(new Error('the network operation failed'), { code: 'unreachable', platformCode: 'EHOSTUNREACH' }) }
    })
    installRouted(dead)
    const error = await dead.fetch!('https://dead.example/api').catch((e: unknown) => e) as TypeError
    expect((error.cause as Error).message).toBe('orivon: connection to dead.example failed (EHOSTUNREACH: the network operation failed)')

    const timedOut = fakeTarget({ connectSecure: async () => { throw Object.assign(new Error('dial timed out'), { code: 'timeout' }) } })
    installRouted(timedOut)
    const second = await timedOut.fetch!('https://slow.example/').catch((e: unknown) => e) as TypeError
    expect((second.cause as Error).message).toBe('orivon: connection to slow.example failed (timeout: dial timed out)')
  })
})

describe('installFetchRoute -- a request that cannot be written never keeps its socket', () => {
  // A header value with a raw CR or LF cannot be put on the wire. The request
  // fails, and the socket it dialled is closed rather than held against the
  // origin's socket allowance.
  it('closes the dialled socket when the request head cannot be built', async () => {
    const { target, socket } = secureTarget()
    const error = await target.fetch!('https://api.example/x', { headers: [['X-Split', 'a\r\nb']] }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TypeError)
    if (socket() !== undefined) expect(socket().closed).toBe(true)
  })
})

describe('installFetchRoute -- header freedom and no ambient credentials', () => {
  it('sends an app-chosen Origin header the browser would normally forbid, verbatim on the wire', async () => {
    const { target, socket } = secureTarget()
    await target.fetch!('https://api.example/x', { headers: { Origin: 'https://impersonated.example' } })
    expect(socket().sent).toContain('Origin: https://impersonated.example')
  })

  it('never attaches a Cookie header on its own, but sends one verbatim when the app sets it', async () => {
    const { target, socket } = secureTarget()
    await target.fetch!('https://api.example/x')
    expect(socket().sent.toLowerCase()).not.toContain('cookie:')
    await target.fetch!('https://api.example/x', { headers: { Cookie: 'session=app-managed-value' } })
    expect(socket().sent).toContain('Cookie: session=app-managed-value')
  })

  it('hands a Set-Cookie response header to the app, but never attaches it to a later request', async () => {
    const withSetCookie = bytes('HTTP/1.1 200 OK\r\nSet-Cookie: sid=abc123\r\nContent-Length: 2\r\n\r\nok')
    const { target, socket } = secureTarget(() => [withSetCookie])
    const first = await target.fetch!('https://api.example/login')
    expect(first.headers.get('set-cookie')).toBe('sid=abc123')
    await target.fetch!('https://api.example/x')
    expect(socket().sent.toLowerCase()).not.toContain('cookie:')
  })

  it('accepts a Headers instance, a plain object, and an array of pairs identically', async () => {
    const heads: string[] = []
    for (const headers of [new Headers({ 'X-Test': 'v1' }), { 'X-Test': 'v1' }, [['X-Test', 'v1']]]) {
      const { target, socket } = secureTarget()
      await target.fetch!('https://api.example/x', { headers })
      heads.push(socket().sent.toLowerCase())
    }
    for (const head of heads) expect(head).toContain('x-test: v1')
  })

  it('sends the platform defaults a browser sends when the app set none, and the app\'s own when it did', async () => {
    let last: FakeSocket | undefined
    const target = fakeTarget({ connectSecure: async () => { last = fakeSocket([OK_RESPONSE]); return last }, userAgent: 'Mozilla/5.0 Test' })
    installRouted(target)
    await target.fetch!('https://api.example/x')
    expect(last!.sent).toContain('User-Agent: Mozilla/5.0 Test')
    expect(last!.sent).toContain('Accept: */*')
    expect(last!.sent).toMatch(/Accept-Encoding: gzip, deflate/)

    await target.fetch!('https://api.example/x', { headers: { 'user-agent': 'app/1', accept: 'application/json' } })
    expect(last!.sent).not.toContain('Mozilla/5.0 Test')
    expect(last!.sent).not.toContain('Accept: */*')
  })
})

describe('installFetchRoute -- request input shapes', () => {
  it('accepts a string, a URL object and a Request-like alike', async () => {
    const heads: string[] = []
    for (const input of ['https://api.example/x', new URL('https://api.example/x'), { url: 'https://api.example/x' }]) {
      const { target, socket } = secureTarget()
      await target.fetch!(input)
      heads.push(socket().sent)
    }
    for (const head of heads) expect(head).toContain('GET /x HTTP/1.1')
    expect(new Set(heads).size).toBe(1)
  })

  it('sends a Request object\'s own method and body when no init overrides them', async () => {
    const { target, socket } = secureTarget()
    await target.fetch!(new Request('https://api.example/x', { method: 'POST', body: 'abcde' }))
    expect(socket().sent).toContain('POST /x HTTP/1.1')
    expect(socket().sent).toContain('Content-Length: 5')
    expect(socket().sent.endsWith('\r\n\r\nabcde')).toBe(true)
  })

  it('normalises only the six standard methods, as the Fetch spec does', async () => {
    const { target, socket } = secureTarget()
    await target.fetch!('https://api.example/x', { method: 'post', body: '' })
    expect(socket().sent).toMatch(/^POST /)
    await target.fetch!('https://api.example/x', { method: 'patch', body: '' })
    expect(socket().sent).toMatch(/^patch /)
    await expect(target.fetch!('https://api.example/x', { method: 'TRACE' })).rejects.toBeInstanceOf(TypeError)
  })

  it('refuses a body on GET, as a real fetch() does', async () => {
    const { target } = secureTarget()
    await expect(target.fetch!('https://api.example/x', { body: 'x' })).rejects.toThrow(/GET\/HEAD/)
  })

  it('rejects an input that names no URL at all, rather than inventing one', async () => {
    const { target } = secureTarget()
    for (const input of [null, undefined]) await expect(target.fetch!(input)).rejects.toThrow(/requires a URL/)
  })
})

describe('installFetchRoute -- response framing', () => {
  it('decodes a chunked-transfer response body, including a chunk split across reads', async () => {
    const { target } = secureTarget(() => [
      bytes('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhel'),
      bytes('lo\r\n6\r\n world\r\n0\r\n\r\n')
    ])
    expect(await (await target.fetch!('https://api.example/x')).text()).toBe('hello world')
  })

  it('decodes a Content-Length body split across reads', async () => {
    const { target } = secureTarget(() => [bytes('HTTP/1.1 201 Created\r\nContent-Length: 11\r\n\r\n'), bytes('hello'), bytes(' world')])
    const response = await target.fetch!('https://api.example/x')
    expect(response.status).toBe(201)
    expect(await response.text()).toBe('hello world')
  })

  it('skips interim 1xx heads and answers with the final one', async () => {
    const { target } = secureTarget(() => [bytes('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 103 Early Hints\r\nLink: </a>\r\n\r\n'), OK_RESPONSE])
    const response = await target.fetch!('https://api.example/x')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('hello')
  })

  it('reads a body that ends with the connection', async () => {
    const { target } = secureTarget(() => [bytes('HTTP/1.1 200 OK\r\n\r\nuntil'), bytes(' close')])
    expect(await (await target.fetch!('https://api.example/x')).text()).toBe('until close')
  })

  it('refuses response headers that never terminate, once they exceed the head cap', async () => {
    const junk = new Uint8Array(ROUTED_MAX_HEAD_BYTES + 8 * 1024).fill(65)
    const { target } = secureTarget(() => [junk])
    const error = await target.fetch!('https://api.example/x').catch((e: unknown) => e) as TypeError
    expect(error.message).toBe('Failed to fetch')
    expect(String((error.cause as Error).message)).toMatch(/head exceeded/)
  })

  it('does not trip the head cap when a small head arrives in the same chunk as a large body', async () => {
    const bodyLength = ROUTED_MAX_HEAD_BYTES + 16 * 1024
    const { target } = secureTarget(() => [concat(bytes(`HTTP/1.1 200 OK\r\nContent-Length: ${bodyLength}\r\n\r\n`), new Uint8Array(bodyLength).fill(97))])
    const response = await target.fetch!('https://api.example/x')
    expect((await response.arrayBuffer()).byteLength).toBe(bodyLength)
  })
})

describe('installFetchRoute -- the request writable outlives the write phase', () => {
  it('never half-closes the socket before the response is read -- a server may read an early FIN as an abort', async () => {
    let writableClosed = false
    let socket: FakeSocket | undefined
    const target = fakeTarget({
      connectSecure: async () => {
        socket = fakeSocket([], true)
        const writer = socket.writable
        return { ...socket, writable: new WritableStream<Uint8Array>({ write: async (c) => { const w = writer.getWriter(); await w.write(c); w.releaseLock() }, close () { writableClosed = true } }) }
      }
    })
    installRouted(target)
    const pending = target.fetch!('https://api.example/x')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(writableClosed).toBe(false)
    socket!.push(OK_RESPONSE)
    socket!.end()
    expect(await (await pending).text()).toBe('hello')
  })
})

describe('installFetchRoute -- init.signal / AbortController', () => {
  it('rejects immediately when the signal is already aborted, and never dials', async () => {
    let dials = 0
    const target = fakeTarget({ connectSecure: async () => { dials++; return fakeSocket([OK_RESPONSE]) } })
    installRouted(target)
    const controller = new AbortController()
    controller.abort()
    await expect(target.fetch!('https://api.example/x', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(dials).toBe(0)
  })

  it('treats `signal: null` as no signal, as real fetch() does', async () => {
    const { target } = secureTarget()
    expect(await (await target.fetch!('https://api.example/x', { signal: null })).text()).toBe('hello')
  })

  it('honours a Request object\'s own signal when init carries none', async () => {
    const { target } = secureTarget()
    const controller = new AbortController()
    controller.abort()
    await expect(target.fetch!(new Request('https://api.example/x', { signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('aborting while the head is awaited rejects AND closes the socket', async () => {
    let socket: FakeSocket | undefined
    const target = fakeTarget({ connectSecure: async () => { socket = fakeSocket([], true); return socket } })
    installRouted(target)
    const controller = new AbortController()
    const pending = target.fetch!('https://api.example/x', { signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(socket!.closed).toBe(true)
  })

  it('aborting while the body streams errors the body with the abort reason AND closes the socket', async () => {
    let socket: FakeSocket | undefined
    const target = fakeTarget({ connectSecure: async () => { socket = fakeSocket([bytes('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nhel')], true); return socket } })
    installRouted(target)
    const controller = new AbortController()
    const response = await target.fetch!('https://api.example/x', { signal: controller.signal })
    const reason = new Error('custom-abort-reason')
    controller.abort(reason)
    await expect(response.text()).rejects.toBe(reason)
    expect(socket!.closed).toBe(true)
  })
})

describe('installFetchRoute -- Content-Encoding', () => {
  it('decodes gzip transparently and keeps the Content-Encoding header, as a browser does', async () => {
    const compressed = new Uint8Array(gzipSync(Buffer.from(JSON.stringify({ hello: 'world' }))))
    const { target } = secureTarget(() => [concat(bytes(`HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${compressed.length}\r\n\r\n`), compressed)])
    const response = await target.fetch!('https://api.example/x')
    expect(response.headers.get('content-encoding')).toBe('gzip')
    await expect(response.json()).resolves.toEqual({ hello: 'world' })
  })

  it('decodes deflate transparently', async () => {
    const compressed = new Uint8Array(deflateSync(Buffer.from(JSON.stringify({ ok: true }))))
    const { target } = secureTarget(() => [concat(bytes(`HTTP/1.1 200 OK\r\nContent-Encoding: deflate\r\nContent-Length: ${compressed.length}\r\n\r\n`), compressed)])
    await expect((await target.fetch!('https://api.example/x')).json()).resolves.toEqual({ ok: true })
  })

  it('undoes stacked codings in reverse order of application', async () => {
    const compressed = new Uint8Array(gzipSync(deflateSync(Buffer.from('twice'))))
    const { target } = secureTarget(() => [concat(bytes(`HTTP/1.1 200 OK\r\nContent-Encoding: deflate, gzip\r\nContent-Length: ${compressed.length}\r\n\r\n`), compressed)])
    expect(await (await target.fetch!('https://api.example/x')).text()).toBe('twice')
  })

  it('streams a large decompressed body instead of refusing it', async () => {
    const raw = new Uint8Array(20 * 1024 * 1024)
    const compressed = new Uint8Array(gzipSync(Buffer.from(raw)))
    const { target } = secureTarget(() => [concat(bytes(`HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${compressed.length}\r\n\r\n`), compressed)])
    const response = await target.fetch!('https://api.example/x')
    expect((await response.arrayBuffer()).byteLength).toBe(raw.byteLength)
  }, 15_000)

  it('leaves an uncompressed response untouched', async () => {
    const { target } = secureTarget()
    const response = await target.fetch!('https://api.example/x')
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(await response.text()).toBe('hello')
  })
})
