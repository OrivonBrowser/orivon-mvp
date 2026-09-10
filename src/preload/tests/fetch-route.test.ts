// Exercises installFetchRoute() directly, the same way tests/main-world-
// socket.test.ts exercises installOrivon() directly: a plain fake `target`
// object rather than a real contextBridge, and the real platform
// ReadableStream/WritableStream/Response/Headers globals Node already
// provides -- installFetchRoute references only these plus its own
// parameter, so it runs identically here and once re-evaluated in a real
// page's main world.
import { describe, expect, it } from 'vitest'
import { installFetchRoute } from '../fetch-route.js'
import type { FetchRouteSocket, FetchRouteTarget } from '../fetch-route.js'

async function tick (times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

/** A fake TcpSocket: `responseChunks` is what the "peer" sends back; `written` accumulates every chunk routedFetch wrote to the request side. */
function fakeSocket (responseChunks: Uint8Array[]): FetchRouteSocket & { written: Uint8Array[], closed: boolean } {
  const state = { written: [] as Uint8Array[], closed: false }
  const readable = new ReadableStream<Uint8Array>({
    start (controller) {
      for (const chunk of responseChunks) controller.enqueue(chunk)
      controller.close()
    }
  })
  const writable = new WritableStream<Uint8Array>({
    write (chunk) { state.written.push(chunk) }
  })
  return {
    readable,
    writable,
    close: async () => { state.closed = true },
    get written () { return state.written },
    get closed () { return state.closed }
  }
}

function bytes (text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function writtenHead (socket: { written: Uint8Array[] }): string {
  return new TextDecoder().decode(socket.written[0])
}

const CANNED_RESPONSE = bytes(
  'HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Type: text/plain\r\n\r\nhello'
)

/** A registered-app target: manifest() resolves, so installFetchRoute's async gate installs the override. */
function appTarget (opts: {
  connect?: () => Promise<FetchRouteSocket>
  connectSecure?: () => Promise<FetchRouteSocket>
  location?: { origin: string, href: string }
  nativeFetch?: (input: unknown, init?: unknown) => Promise<Response>
}): FetchRouteTarget {
  const target: FetchRouteTarget = {
    orivon: {
      app: { manifest: async () => ({ orivonApiVersion: 0 }) },
      net: {
        connect: opts.connect ?? (async () => { throw new Error('unexpected net.connect call') }),
        connectSecure: opts.connectSecure ?? (async () => { throw new Error('unexpected net.connectSecure call') })
      }
    }
  }
  if (opts.location !== undefined) target.location = opts.location
  if (opts.nativeFetch !== undefined) target.fetch = opts.nativeFetch
  return target
}

describe('installFetchRoute -- gating', () => {
  it('does not install a fetch override for an unregistered origin (manifest() rejects)', async () => {
    const target: FetchRouteTarget = {
      orivon: {
        app: { manifest: async () => { throw new Error('not registered') } },
        net: { connect: async () => fakeSocket([]), connectSecure: async () => fakeSocket([]) }
      },
      fetch: async () => new Response('native')
    }
    installFetchRoute(target)
    await tick()
    expect(typeof target.fetch).toBe('function')
    const response = await target.fetch!('https://example.test/')
    expect(await response.text()).toBe('native')
  })

  it('installs a routed fetch once manifest() resolves, non-configurable and non-writable', async () => {
    const target = appTarget({ connect: async () => fakeSocket(CANNED_RESPONSE_CHUNKS()) })
    installFetchRoute(target)
    await tick()
    const descriptor = Object.getOwnPropertyDescriptor(target, 'fetch')
    expect(descriptor?.writable).toBe(false)
    expect(descriptor?.configurable).toBe(false)
  })

  it('does nothing at all when orivon.net is absent (no capability surface to route through)', () => {
    const target: FetchRouteTarget = { orivon: { app: { manifest: async () => ({}) } } }
    expect(() => { installFetchRoute(target) }).not.toThrow()
    expect(target.fetch).toBeUndefined()
  })
})

function CANNED_RESPONSE_CHUNKS (): Uint8Array[] {
  return [CANNED_RESPONSE]
}

describe('installFetchRoute -- routing decisions', () => {
  it('leaves a same-origin request to native fetch, unrouted', async () => {
    let netCalled = false
    const target = appTarget({
      connect: async () => { netCalled = true; return fakeSocket([]) },
      location: { origin: 'https://app.example', href: 'https://app.example/index.html' },
      nativeFetch: async () => new Response('same-origin bundle asset')
    })
    installFetchRoute(target)
    await tick()
    const response = await target.fetch!('https://app.example/manifest.json')
    expect(await response.text()).toBe('same-origin bundle asset')
    expect(netCalled).toBe(false)
  })

  it('routes an http: request through net.connect and https: through net.connectSecure', async () => {
    let usedConnect = false
    let usedConnectSecure = false
    const target = appTarget({
      connect: async () => { usedConnect = true; return fakeSocket(CANNED_RESPONSE_CHUNKS()) },
      connectSecure: async () => { usedConnectSecure = true; return fakeSocket(CANNED_RESPONSE_CHUNKS()) },
      location: { origin: 'https://app.example', href: 'https://app.example/' }
    })
    installFetchRoute(target)
    await tick()
    await target.fetch!('http://api.example/x')
    expect(usedConnect).toBe(true)
    expect(usedConnectSecure).toBe(false)
    await target.fetch!('https://api.example/x')
    expect(usedConnectSecure).toBe(true)
  })
})

describe('installFetchRoute -- header freedom and no ambient credentials', () => {
  it("sends an app-chosen Origin header the browser would normally forbid, verbatim on the wire", async () => {
    let socket: ReturnType<typeof fakeSocket> | undefined
    const target = appTarget({
      connectSecure: async () => { socket = fakeSocket(CANNED_RESPONSE_CHUNKS()); return socket }
    })
    installFetchRoute(target)
    await tick()
    await target.fetch!('https://api.example/x', { headers: { Origin: 'https://impersonated.example' } })
    expect(writtenHead(socket!)).toContain('Origin: https://impersonated.example')
  })

  it('never attaches a Cookie header on its own, but sends one verbatim when the app sets it', async () => {
    let socketA: ReturnType<typeof fakeSocket> | undefined
    const targetA = appTarget({ connectSecure: async () => { socketA = fakeSocket(CANNED_RESPONSE_CHUNKS()); return socketA } })
    installFetchRoute(targetA)
    await tick()
    await targetA.fetch!('https://api.example/x')
    expect(writtenHead(socketA!).toLowerCase()).not.toContain('cookie:')

    let socketB: ReturnType<typeof fakeSocket> | undefined
    const targetB = appTarget({ connectSecure: async () => { socketB = fakeSocket(CANNED_RESPONSE_CHUNKS()); return socketB } })
    installFetchRoute(targetB)
    await tick()
    await targetB.fetch!('https://api.example/x', { headers: { Cookie: 'session=app-managed-value' } })
    expect(writtenHead(socketB!)).toContain('Cookie: session=app-managed-value')
  })

  it("hands a Set-Cookie response header to the app (it must manage its own session -- there is no jar to hide it in), but never automatically attaches it to a LATER request", async () => {
    const withSetCookie = bytes('HTTP/1.1 200 OK\r\nSet-Cookie: sid=abc123\r\nContent-Length: 2\r\n\r\nok')
    let firstSocket: ReturnType<typeof fakeSocket> | undefined
    const target = appTarget({
      connectSecure: async () => {
        if (firstSocket === undefined) { firstSocket = fakeSocket([withSetCookie]); return firstSocket }
        return fakeSocket(CANNED_RESPONSE_CHUNKS())
      }
    })
    installFetchRoute(target)
    await tick()

    const first = await target.fetch!('https://api.example/login')
    expect(first.headers.get('set-cookie')).toBe('sid=abc123')
    expect(firstSocket!.closed).toBe(true)

    let secondSocket: ReturnType<typeof fakeSocket> | undefined
    target.orivon!.net!.connectSecure = async () => { secondSocket = fakeSocket(CANNED_RESPONSE_CHUNKS()); return secondSocket }
    await target.fetch!('https://api.example/x')
    expect(writtenHead(secondSocket!).toLowerCase()).not.toContain('cookie:')
  })

  it('rejects an ungranted host without prompting -- connectSecure rejects, fetch rejects with a TypeError, and nothing is ever written or read', async () => {
    let dialAttempts = 0
    const target = appTarget({
      connectSecure: async () => { dialAttempts++; throw Object.assign(new Error('denied'), { code: 'denied' }) }
    })
    installFetchRoute(target)
    await tick()
    await expect(target.fetch!('https://not-granted.example/')).rejects.toBeInstanceOf(TypeError)
    expect(dialAttempts).toBe(1)
  })
})

describe('installFetchRoute -- header input shapes', () => {
  it('accepts a Headers instance, a plain object, and an array of pairs identically', async () => {
    const seen: string[] = []
    async function fetchWith (headers: unknown): Promise<void> {
      let socket: ReturnType<typeof fakeSocket> | undefined
      const target = appTarget({ connectSecure: async () => { socket = fakeSocket(CANNED_RESPONSE_CHUNKS()); return socket } })
      installFetchRoute(target)
      await tick()
      await target.fetch!('https://api.example/x', { headers })
      seen.push(writtenHead(socket!))
    }
    await fetchWith(new Headers({ 'X-Test': 'v1' }))
    await fetchWith({ 'X-Test': 'v1' })
    await fetchWith([['X-Test', 'v1']])
    // The native Headers class itself lowercases names on iteration (a
    // faithful, expected difference in casing, not a bug) -- checked
    // case-insensitively so all three input shapes are held to the same
    // standard: the value made it onto the wire, verbatim.
    for (const head of seen) expect(head.toLowerCase()).toContain('x-test: v1')
  })
})

describe('installFetchRoute -- response body framing', () => {
  it('decodes a chunked-transfer response body correctly', async () => {
    const chunked = bytes('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n')
    const target = appTarget({ connectSecure: async () => fakeSocket([chunked]) })
    installFetchRoute(target)
    await tick()
    const response = await target.fetch!('https://api.example/x')
    expect(await response.text()).toBe('hello world')
  })

  it('decodes a Content-Length response body correctly, including when the peer splits it across reads', async () => {
    const head = bytes('HTTP/1.1 201 Created\r\nContent-Length: 11\r\n\r\n')
    const part1 = bytes('hello')
    const part2 = bytes(' world')
    const target = appTarget({ connectSecure: async () => fakeSocket([head, part1, part2]) })
    installFetchRoute(target)
    await tick()
    const response = await target.fetch!('https://api.example/x')
    expect(response.status).toBe(201)
    expect(await response.text()).toBe('hello world')
  })

  it('reports a POST body with an automatic Content-Length', async () => {
    let socket: ReturnType<typeof fakeSocket> | undefined
    const target = appTarget({ connectSecure: async () => { socket = fakeSocket(CANNED_RESPONSE_CHUNKS()); return socket } })
    installFetchRoute(target)
    await tick()
    await target.fetch!('https://api.example/x', { method: 'POST', body: 'abcde' })
    const head = writtenHead(socket!)
    expect(head).toContain('POST /x HTTP/1.1')
    expect(head).toContain('Content-Length: 5')
  })
})
