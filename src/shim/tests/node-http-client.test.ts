import { describe, expect, it, vi } from 'vitest'
import { createHttpModule } from '../node-http-client.js'
import { createFakeTcpSocket } from './support/fake-tcp-socket.js'
import type { TcpSocket } from '../../contracts/handles.js'
import type { IncomingMessage } from '../node-http-message.js'

const enc = new TextEncoder()
const dec = new TextDecoder()

function moduleOver (connect: () => Promise<TcpSocket>, defaultPort = 80): ReturnType<typeof createHttpModule> {
  return createHttpModule({ connect, defaultPort })
}

function collectBody (res: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = []
    res.on('data', (chunk: Uint8Array) => chunks.push(chunk))
    res.on('end', () => resolve(dec.decode(concat(chunks))))
  })
}

function concat (chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { out.set(c, offset); offset += c.length }
  return out
}

describe('createHttpModule -- request framing', () => {
  it('sends a well-formed GET request line, Host and Connection: close', async () => {
    const fake = createFakeTcpSocket()
    const http = moduleOver(async () => fake.socket)

    http.get({ host: 'example.com', path: '/foo?x=1' })
    // Let the async connect + send pipeline run.
    await vi.waitFor(() => expect(fake.written.length).toBeGreaterThan(0))

    const head = dec.decode(fake.written[0])
    expect(head).toBe('GET /foo?x=1 HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n')
  })

  it('omits the port from Host when it matches the default, includes it otherwise', async () => {
    const fake = createFakeTcpSocket()
    const http = moduleOver(async () => fake.socket, 80)
    http.get({ host: 'example.com', port: 8080, path: '/' })
    await vi.waitFor(() => expect(fake.written.length).toBeGreaterThan(0))
    expect(dec.decode(fake.written[0])).toContain('Host: example.com:8080')
  })

  it('buffers multiple write() calls and sends one Content-Length body after end()', async () => {
    const fake = createFakeTcpSocket()
    const http = moduleOver(async () => fake.socket)
    const req = http.request({ host: 'example.com', method: 'POST', path: '/announce' })
    req.write('hello ')
    req.write('world')
    req.end()

    await vi.waitFor(() => expect(fake.written.length).toBeGreaterThanOrEqual(2))
    const head = dec.decode(fake.written[0])
    expect(head).toContain('POST /announce HTTP/1.1')
    expect(head).toContain('Content-Length: 11')
    expect(dec.decode(fake.written[1])).toBe('hello world')
  })

  it('lets a caller override Connection and Host explicitly', async () => {
    const fake = createFakeTcpSocket()
    const http = moduleOver(async () => fake.socket)
    http.get({ host: 'example.com', path: '/', headers: { Connection: 'keep-alive', Host: 'override.example' } })
    await vi.waitFor(() => expect(fake.written.length).toBeGreaterThan(0))
    const head = dec.decode(fake.written[0])
    expect(head).toContain('Connection: keep-alive')
    expect(head).toContain('Host: override.example')
    expect(head).not.toContain('Connection: close')
  })

  it('setHeader throws synchronously on a header-injection attempt, matching Node', async () => {
    const fake = createFakeTcpSocket()
    const http = moduleOver(async () => fake.socket)
    const req = http.request({ host: 'example.com', path: '/' })
    expect(() => req.setHeader('X-Evil', 'value\r\nX-Injected: yes')).toThrow(/invalid header value/)
  })

  it('resolves a plain URL string into host, path and method', async () => {
    const fake = createFakeTcpSocket()
    const http = moduleOver(async () => fake.socket)
    http.get('http://example.com/path?q=2')
    await vi.waitFor(() => expect(fake.written.length).toBeGreaterThan(0))
    expect(dec.decode(fake.written[0])).toContain('GET /path?q=2 HTTP/1.1')
  })
})

describe('createHttpModule -- response handling', () => {
  it('emits response, then data, then end, and closes the socket on completion', async () => {
    const fake = createFakeTcpSocket()
    const http = moduleOver(async () => fake.socket)
    const req = http.get({ host: 'example.com', path: '/' })

    await vi.waitFor(() => expect(fake.written.length).toBeGreaterThan(0))
    fake.push(enc.encode('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello'))
    const res = await new Promise<IncomingMessage>((resolve) => req.once('response', resolve))

    expect(res.statusCode).toBe(200)
    const body = await collectBody(res)
    expect(body).toBe('hello')
    await vi.waitFor(() => expect(fake.closed()).toBe(true))
  })

  it('decodes a chunked response body identically to a Content-Length one', async () => {
    const fake = createFakeTcpSocket()
    const http = moduleOver(async () => fake.socket)
    const req = http.get({ host: 'example.com', path: '/' })
    await vi.waitFor(() => expect(fake.written.length).toBeGreaterThan(0))
    fake.push(enc.encode('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n'))
    const res = await new Promise<IncomingMessage>((resolve) => req.once('response', resolve))
    expect(await collectBody(res)).toBe('hello')
  })

  // node-https.ts's header describes res.socket.getPeerCertificate() as
  // absent (no TLS-socket API), which implies res.socket itself exists --
  // before this fix it did not, and `res.socket.anything` threw
  // "Cannot read properties of null" instead of the documented, narrower gap.
  it('gives the response a real .socket carrying the connection\'s address fields', async () => {
    const fake = createFakeTcpSocket()
    const http = moduleOver(async () => fake.socket)
    const req = http.get({ host: 'example.com', path: '/' })
    await vi.waitFor(() => expect(fake.written.length).toBeGreaterThan(0))
    fake.push(enc.encode('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'))
    const res = await new Promise<IncomingMessage>((resolve) => req.once('response', resolve))

    expect(res.socket).not.toBeNull()
    expect(res.socket?.remoteAddress).toBe(fake.socket.remoteAddress)
    expect(res.socket?.remotePort).toBe(fake.socket.remotePort)
  })

  it('supports the http.get(url, callback) convenience form', async () => {
    const fake = createFakeTcpSocket()
    const http = moduleOver(async () => fake.socket)
    const responded = new Promise<IncomingMessage>((resolve) => {
      http.get('http://example.com/', (res: IncomingMessage) => resolve(res))
    })
    await vi.waitFor(() => expect(fake.written.length).toBeGreaterThan(0))
    fake.push(enc.encode('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'))
    const res = await responded
    expect(res.statusCode).toBe(200)
  })
})

describe('createHttpModule -- denial and transport failure', () => {
  it('surfaces a denied grant as an "error" event with code \'denied\', not a fake network errno', async () => {
    const denial = Object.assign(new Error('no grant for example.com:80'), { code: 'denied' })
    const http = moduleOver(async () => { throw denial })
    const req = http.get({ host: 'example.com', path: '/' })

    const error = await new Promise<Error & { code: string }>((resolve) => req.once('error', resolve))
    expect(error.code).toBe('denied')
    expect(error.message).toContain('no grant for example.com:80')
  })

  it('emits "error" on the request when the connection is reset before any response arrives', async () => {
    const fake = createFakeTcpSocket()
    const http = moduleOver(async () => fake.socket)
    const req = http.get({ host: 'example.com', path: '/' })
    await vi.waitFor(() => expect(fake.written.length).toBeGreaterThan(0))

    const errored = new Promise<Error & { code: string }>((resolve) => req.once('error', resolve))
    fake.fail('reset', 'peer reset the connection')
    const error = await errored
    expect(error.code).toBe('reset')
  })

  it('emits "error" on the response, not the request, once headers have already arrived', async () => {
    const fake = createFakeTcpSocket()
    const http = moduleOver(async () => fake.socket)
    const req = http.get({ host: 'example.com', path: '/' })
    let reqErrored = false
    req.once('error', () => { reqErrored = true })

    await vi.waitFor(() => expect(fake.written.length).toBeGreaterThan(0))
    fake.push(enc.encode('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial'))
    const gotRes = await new Promise<IncomingMessage>((resolve) => req.once('response', resolve))
    const resError = new Promise<Error & { code: string }>((resolve) => gotRes.once('error', resolve))
    fake.fail('reset', 'peer reset mid-body')

    const error = await resError
    expect(error.code).toBe('reset')
    expect(reqErrored).toBe(false)
  })
})
