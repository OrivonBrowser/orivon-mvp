// ClientRequest's Node surface: options, header methods, timeouts, abort
// signals, flushHeaders framing, 1xx events, upgrade handoff and
// createConnection -- over a fake TcpSocket.

import { describe, expect, it, vi } from 'vitest'
import { createHttpModule, type ClientRequest } from '../node-http-client.js'
import type { IncomingMessage } from '../node-http-message.js'
import { Socket } from '../node-net-socket.js'
import { Agent } from '../node-http-agent.js'
import { createFakeTcpSocket, type FakeTcpSocket } from './support/fake-tcp-socket.js'
import { httpLifecycleSuite } from './support/http-lifecycle-suite.js'

const enc = new TextEncoder()
const dec = new TextDecoder()

httpLifecycleSuite('node:stream')

function over (fake: FakeTcpSocket = createFakeTcpSocket()): { fake: FakeTcpSocket, calls: Array<{ host: string, port: number }>, http: ReturnType<typeof createHttpModule> } {
  const calls: Array<{ host: string, port: number }> = []
  const http = createHttpModule({ connect: async (opts) => { calls.push(opts); return fake.socket }, defaultPort: 80 })
  return { fake, calls, http }
}

function written (fake: FakeTcpSocket): string {
  return fake.written.map((chunk) => dec.decode(chunk)).join('')
}

describe('request options', () => {
  it('a bracketed IPv6 URL dials the bare address and sends a bracketed Host', async () => {
    const { fake, calls, http } = over()
    http.get('http://[::1]:8080/status')
    await vi.waitFor(() => expect(fake.written.length).toBeGreaterThan(0))
    expect(calls).toEqual([{ host: '::1', port: 8080 }])
    expect(written(fake)).toContain('Host: [::1]:8080\r\n')
  })

  it('auth, and URL credentials, become a Basic Authorization header', async () => {
    const { fake, http } = over()
    http.get({ host: 'example.com', path: '/', auth: 'user:pässword' })
    await vi.waitFor(() => expect(fake.written.length).toBeGreaterThan(0))
    expect(written(fake)).toContain(`Authorization: Basic ${Buffer.from('user:pässword').toString('base64')}\r\n`)

    const second = over()
    second.http.get('http://alice:s%3Acret@example.com/')
    await vi.waitFor(() => expect(second.fake.written.length).toBeGreaterThan(0))
    expect(written(second.fake)).toContain(`Authorization: Basic ${Buffer.from('alice:s:cret').toString('base64')}\r\n`)
  })

  it('setHost: false sends no Host header; agent, family and localAddress are accepted', async () => {
    const { fake, http } = over()
    http.get({ host: 'example.com', path: '/', setHost: false, agent: new Agent({ keepAlive: true }), family: 6, localAddress: '::' })
    await vi.waitFor(() => expect(fake.written.length).toBeGreaterThan(0))
    expect(written(fake)).not.toContain('Host:')
  })

  it('rejects an unescaped path and a bad port synchronously, as Node does', () => {
    const { http } = over()
    expect(() => http.request({ host: 'x', path: '/a b' })).toThrow(expect.objectContaining({ code: 'ERR_UNESCAPED_CHARACTERS' }))
    expect(() => http.request({ host: 'x', port: 70000 })).toThrow(expect.objectContaining({ code: 'ERR_SOCKET_BAD_PORT' }))
  })

  it('uses createConnection when given, with the request options', async () => {
    const { fake, calls, http } = over()
    const created: Array<Record<string, unknown>> = []
    const req = http.get({
      host: 'example.com',
      path: '/',
      createConnection: (opts: Record<string, unknown>) => {
        created.push(opts)
        return new Socket().connect({ host: 'relay.example', port: 9 }).on('error', () => {})
      }
    })
    req.on('error', () => {})
    await vi.waitFor(() => expect(created).toHaveLength(1))
    expect(created[0]).toMatchObject({ host: 'example.com', port: 80 })
    expect(calls).toHaveLength(0)
    void fake
    req.destroy()
  })
})

describe('ClientRequest methods', () => {
  it('header accessors mirror Node, and setting a header once sent throws ERR_HTTP_HEADERS_SENT', async () => {
    const { fake, http } = over()
    const req = http.request({ host: 'example.com', path: '/', headers: { 'X-One': '1' } })
    req.setHeader('X-Two', ['a', 'b'])
    expect(req.getHeader('x-one')).toBe('1')
    expect(req.hasHeader('X-TWO')).toBe(true)
    expect(req.getHeaders()).toMatchObject({ 'x-one': '1', 'x-two': ['a', 'b'], host: 'example.com' })
    expect(req.getHeaderNames()).toContain('x-two')
    req.removeHeader('X-One')
    expect(req.hasHeader('x-one')).toBe(false)
    expect(req.headersSent).toBe(false)
    req.end()
    await vi.waitFor(() => expect(fake.written.length).toBeGreaterThan(0))
    expect(req.headersSent).toBe(true)
    expect(() => req.setHeader('X-Late', '1')).toThrow(expect.objectContaining({ code: 'ERR_HTTP_HEADERS_SENT' }))
  })

  it('emits "socket" with a net.Socket, whose setKeepAlive is synchronous', async () => {
    const { http } = over()
    const req = http.get({ host: 'example.com', path: '/' })
    const socket = await new Promise<Socket>((resolve) => req.once('socket', resolve))
    expect(socket).toBeInstanceOf(Socket)
    expect(socket.setKeepAlive(true, 60000)).toBe(socket)
    expect(req.socket).toBe(socket)
    req.on('error', () => {})
    req.destroy()
  })

  it('the timeout option and setTimeout() emit "timeout" on an idle request without destroying it', async () => {
    const { http } = over()
    const req = http.get({ host: 'example.com', path: '/', timeout: 20 })
    const onTimeout = vi.fn()
    req.setTimeout(20, onTimeout)
    await vi.waitFor(() => expect(onTimeout).toHaveBeenCalled())
    expect(req.destroyed).toBe(false)
    req.on('error', () => {})
    req.destroy()
  })

  it('an aborted signal destroys the request with an AbortError', async () => {
    const { http } = over()
    const controller = new AbortController()
    const req = http.get({ host: 'example.com', path: '/', signal: controller.signal })
    const error = new Promise<Error & { code?: string }>((resolve) => req.once('error', resolve))
    controller.abort()
    expect(await error).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' })
  })

  it('flushHeaders() sends the head before end(); a POST body then streams chunked and ends with the last chunk', async () => {
    const { fake, http } = over()
    const req = http.request({ host: 'example.com', method: 'POST', path: '/upload' })
    req.flushHeaders()
    await vi.waitFor(() => expect(fake.written.length).toBe(1))
    expect(written(fake)).toContain('Transfer-Encoding: chunked\r\n')
    req.write('hello')
    req.end()
    await vi.waitFor(() => expect(written(fake)).toMatch(/0\r\n\r\n$/))
    expect(written(fake)).toContain('\r\n\r\n5\r\nhello\r\n0\r\n\r\n')
  })
})

describe('1xx, upgrade and CONNECT', () => {
  async function sent (fake: FakeTcpSocket): Promise<void> {
    await vi.waitFor(() => expect(fake.written.length).toBeGreaterThan(0))
  }

  it('emits "information" for each 1xx and "continue" for 100, before "response"', async () => {
    const { fake, http } = over()
    const req = http.get({ host: 'example.com', path: '/' })
    const events: string[] = []
    req.on('information', (info: { statusCode: number }) => events.push(`information ${info.statusCode}`))
    req.on('continue', () => events.push('continue'))
    req.on('response', (res: IncomingMessage) => { events.push(`response ${String(res.statusCode)}`); res.resume() })
    await sent(fake)
    fake.push(enc.encode('HTTP/1.1 103 Early Hints\r\n\r\nHTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n'))
    await vi.waitFor(() => expect(events).toContain('response 204'))
    expect(events).toEqual(['information 103', 'continue', 'information 100', 'response 204'])
  })

  it('an Expect: 100-continue request sends its head at once, before end()', async () => {
    const { fake, http } = over()
    http.request({ host: 'example.com', method: 'PUT', path: '/big', headers: { Expect: '100-continue', 'Content-Length': '3' } })
    await vi.waitFor(() => expect(written(fake)).toContain('Expect: 100-continue'))
  })

  it('hands a 101 over as "upgrade" (res, socket, head), with the socket still live for its new owner', async () => {
    const { fake, http } = over()
    const req = http.request({ host: 'example.com', path: '/ws', headers: { Connection: 'Upgrade', Upgrade: 'websocket' } })
    req.end()
    const upgraded = new Promise<[IncomingMessage, Socket, Buffer]>((resolve) => req.once('upgrade', (res, socket, head) => resolve([res, socket, head])))
    await sent(fake)
    fake.push(enc.encode('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nfirst'))
    const [res, socket, head] = await upgraded
    expect(res.statusCode).toBe(101)
    expect(Buffer.isBuffer(head)).toBe(true)
    expect(head.toString()).toBe('first')
    expect(socket.destroyed).toBe(false)

    const later = new Promise<string>((resolve) => socket.once('data', (chunk: Buffer) => resolve(chunk.toString())))
    fake.push(enc.encode('second'))
    expect(await later).toBe('second')
    socket.write('frame')
    await vi.waitFor(() => expect(written(fake)).toMatch(/frame$/))
    expect(fake.closed()).toBe(false)
    socket.destroy()
  })

  it('a 101 with no "upgrade" listener destroys the socket and closes the request without an error', async () => {
    const { fake, http } = over()
    const req = http.request({ host: 'example.com', path: '/ws', headers: { Connection: 'Upgrade', Upgrade: 'websocket' } })
    req.end()
    const onError = vi.fn()
    req.on('error', onError)
    await sent(fake)
    fake.push(enc.encode('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n'))
    await new Promise<void>((resolve) => req.once('close', () => resolve()))
    await vi.waitFor(() => expect(fake.closed()).toBe(true))
    expect(onError).not.toHaveBeenCalled()
  })

  it('a CONNECT response is delivered as "connect"', async () => {
    const { fake, http } = over()
    const req = http.request({ host: 'proxy.example', method: 'CONNECT', path: 'target.example:443' })
    req.end()
    const connected = new Promise<number | null>((resolve) => req.once('connect', (res: IncomingMessage, socket: Socket) => { socket.destroy(); resolve(res.statusCode) }))
    await sent(fake)
    fake.push(enc.encode('HTTP/1.1 200 Connection Established\r\n\r\n'))
    expect(await connected).toBe(200)
  })
})

describe('request objects reach the caller the Node way', () => {
  it('a response nobody listens for is drained, so the request still completes', async () => {
    const { fake, http } = over()
    const req: ClientRequest = http.get({ host: 'example.com', path: '/' })
    await vi.waitFor(() => expect(fake.written.length).toBeGreaterThan(0))
    fake.push(enc.encode('HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc'))
    await new Promise<void>((resolve) => req.once('close', () => resolve()))
    await vi.waitFor(() => expect(fake.closed()).toBe(true))
  })
})
