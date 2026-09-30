import { afterEach, describe, expect, it } from 'vitest'
import { kConnections } from '../server.js'
import type { IncomingMessage } from '../message.js'
import { fetchFrom, rawExchange, startServer, stopServers, waitFor } from '../../tests/support/http-server-harness.js'

afterEach(stopServers)

const GET = (path: string, extra = ''): string => `GET ${path} HTTP/1.1\r\nHost: x\r\n${extra}\r\n`

describe('bytes pipelined behind a request are bounded', () => {
  it('holds a bounded backlog however the request\'s reader behaves, and still answers every request in order', async () => {
    let captured: IncomingMessage | undefined
    const { server, port } = await startServer((req, res) => {
      if (req.url === '/first') {
        captured = req
        setTimeout(() => { req.resume(); res.end('r/first') }, 700)
        return
      }
      req.resume()
      res.end(`r${String(req.url)}`)
    })
    const count = 500
    const pad = 'a'.repeat(1000)
    const pipelined = Array.from({ length: count }, (_, i) => GET(`/${String(i)}`, `X-Pad: ${pad}\r\n`))
    const script = ['POST /first HTTP/1.1\r\nHost: x\r\nContent-Length: 10\r\n\r\n0123456789']
    for (let i = 0; i < count; i += 50) script.push(pipelined.slice(i, i + 50).join(''))

    let peak = 0
    let hammered = false
    let sampling = true
    const sampler = (async () => {
      while (sampling) {
        for (const connection of server[kConnections]) {
          peak = Math.max(peak, connection.heldBytes)
          if (!hammered && connection.heldBytes > 64 * 1024 && captured !== undefined) {
            hammered = true
            for (let i = 0; i < 50; i++) captured._read()
          }
        }
        await new Promise((r) => setTimeout(r, 2))
      }
    })()
    const { data } = await rawExchange(port, script, { gapMs: 4, until: `r/${String(count - 1)}`, timeoutMs: 15_000 })
    sampling = false
    await sampler
    expect(hammered, 'the backlog passed the cap while the first request was still being answered').toBe(true)
    expect(peak, 'what the connection held stayed near the cap').toBeLessThan(200 * 1024)
    const answers = [...data.matchAll(/\r\n\r\n(r\/(?:first|\d+))/g)].map((match) => match[1])
    expect(answers).toEqual(['r/first', ...Array.from({ length: count }, (_, i) => `r/${String(i)}`)])
  }, 30_000)
})

describe('the headers clock starts with the connection', () => {
  it('answers 408 to a connection that sends nothing, and reaches clientError with ERR_HTTP_REQUEST_TIMEOUT when someone listens', async () => {
    const { server, port } = await startServer((_req, res) => { res.end() }, { headersTimeout: 150 })
    const silent = await rawExchange(port, [], { timeoutMs: 1500 })
    expect(silent).toEqual({ data: 'HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n', closed: true })
    const codes: string[] = []
    server.on('clientError', (error: Error & { code?: string }, socket) => { codes.push(String(error.code)); socket.destroy() })
    await rawExchange(port, [], { timeoutMs: 1500 })
    expect(codes).toEqual(['ERR_HTTP_REQUEST_TIMEOUT'])
  })

  it('leaves a silent connection alone when headersTimeout is 0, and an idle keep-alive one to keepAliveTimeout', async () => {
    const { port } = await startServer((_req, res) => { res.end('k') }, { headersTimeout: 0, keepAliveTimeout: 5000 })
    expect((await rawExchange(port, [], { timeoutMs: 400 })).closed).toBe(false)
    const timed = await startServer((_req, res) => { res.end('k') }, { headersTimeout: 150, keepAliveTimeout: 5000 })
    const { data, closed } = await rawExchange(timed.port, GET('/'), { timeoutMs: 600 })
    expect(data).toContain('k')
    expect(data).not.toContain('408')
    expect(closed).toBe(false)
  })
})

describe('a malformed request on a connection that already answered one', () => {
  it('is answered 431 for an oversized head, and 400 for garbage, behind the first response', async () => {
    const { port } = await startServer((_req, res) => { res.end('ok') })
    const big = await rawExchange(port, [GET('/'), `GET /x HTTP/1.1\r\nHost: x\r\nX: ${'a'.repeat(20000)}\r\n\r\n`], { timeoutMs: 800 })
    expect(big.data).toMatch(/^HTTP\/1\.1 200 OK[\s\S]*\r\n\r\nokHTTP\/1\.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n$/)
    expect(big.closed).toBe(true)
    const garbage = await rawExchange(port, [GET('/'), 'BLAH\r\n\r\n'], { timeoutMs: 800 })
    expect(garbage.data).toMatch(/\r\n\r\nokHTTP\/1\.1 400 Bad Request\r\nConnection: close\r\n\r\n$/)
    expect(garbage.closed).toBe(true)
  })
})

describe('listen() while a close() is still draining', () => {
  it('throws ERR_SERVER_ALREADY_LISTEN and leaves the pending close alone', async () => {
    const { server, port } = await startServer((_req, res) => { setTimeout(() => res.end('done'), 250) })
    const inflight = fetchFrom(port, '/')
    await new Promise((r) => setTimeout(r, 60))
    const events: string[] = []
    server.on('close', () => events.push('close'))
    server.close(() => events.push('callback'))
    expect(() => server.listen(0)).toThrow(expect.objectContaining({ code: 'ERR_SERVER_ALREADY_LISTEN' }))
    expect(server.listening).toBe(false)
    expect((await inflight).text).toBe('done')
    await waitFor(() => events.length === 2)
    expect(events).toEqual(['close', 'callback'])
  })
})
