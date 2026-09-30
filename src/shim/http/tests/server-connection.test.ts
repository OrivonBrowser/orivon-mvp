import { afterEach, describe, expect, it } from 'vitest'
import { Agent, request } from 'node:http'
import { connect } from 'node:net'
import { createHash } from 'node:crypto'
import { createServer } from '../server.js'
import { fetchFrom, rawExchange, splitReply, startServer, stopServers, waitFor } from '../../tests/support/http-server-harness.js'

afterEach(stopServers)

const GET = (path: string, extra = ''): string => `GET ${path} HTTP/1.1\r\nHost: x\r\n${extra}\r\n`

describe('one connection, many requests', () => {
  it('answers pipelined requests one at a time and in order, never running two handlers at once', async () => {
    let running = 0
    let overlapped = false
    const order: string[] = []
    const { port } = await startServer((req, res) => {
      running++
      if (running > 1) overlapped = true
      order.push(`start ${req.url}`)
      setTimeout(() => { running--; order.push(`end ${req.url}`); res.end(`r${req.url}`) }, req.url === '/1' ? 80 : 10)
    })
    const { data } = await rawExchange(port, GET('/1') + GET('/2') + GET('/3', 'Connection: close\r\n'), { timeoutMs: 1500 })
    expect(overlapped).toBe(false)
    expect(order).toEqual(['start /1', 'end /1', 'start /2', 'end /2', 'start /3', 'end /3'])
    expect([...data.matchAll(/\r\n\r\n(r\/\d)/g)].map((m) => m[1])).toEqual(['r/1', 'r/2', 'r/3'])
  })

  it('reads a pipelined POST body, then the request behind it', async () => {
    const seen: string[] = []
    const { port } = await startServer((req, res) => {
      const parts: Buffer[] = []
      req.on('data', (c: Buffer) => parts.push(c))
      req.on('end', () => { seen.push(`${req.url} ${Buffer.concat(parts).toString()}`); res.end('ok') })
    })
    await rawExchange(port, 'POST /a HTTP/1.1\r\nHost: x\r\nContent-Length: 3\r\n\r\nabc' + 'POST /b HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\nde' + GET('/c', 'Connection: close\r\n'), { timeoutMs: 800 })
    expect(seen).toEqual(['/a abc', '/b de', '/c '])
  })

  it('reuses one connection for keep-alive requests from a real client agent', async () => {
    const remotePorts: (number | undefined)[] = []
    const { port } = await startServer((req, res) => { remotePorts.push(req.socket.remotePort); res.end('x') })
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    const get = async (): Promise<string> => await new Promise((resolve, reject) => {
      request({ host: '127.0.0.1', port, agent }, (res) => { let text = ''; res.on('data', (c: Buffer) => { text += c.toString() }); res.on('end', () => resolve(text)) }).on('error', reject).end()
    })
    expect(await get()).toBe('x')
    expect(await get()).toBe('x')
    expect(await get()).toBe('x')
    agent.destroy()
    expect(remotePorts).toHaveLength(3)
    expect(new Set(remotePorts).size).toBe(1)
  })

  it('serves fetch() (undici, which pools connections)', async () => {
    const { port } = await startServer((req, res) => {
      const parts: Buffer[] = []
      req.on('data', (c: Buffer) => parts.push(c))
      req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ url: req.url, echo: Buffer.concat(parts).toString() })) })
    })
    const first = await fetch(`http://127.0.0.1:${port}/a`, { method: 'POST', body: 'payload' })
    expect(await first.json()).toEqual({ url: '/a', echo: 'payload' })
    const second = await fetch(`http://127.0.0.1:${port}/b`)
    expect(await second.json()).toEqual({ url: '/b', echo: '' })
  })

  it('emits connection once per socket, before the first request', async () => {
    const events: string[] = []
    const { server, port } = await startServer((req, res) => { events.push(`request ${req.url}`); res.end() })
    server.on('connection', () => events.push('connection'))
    await rawExchange(port, GET('/1') + GET('/2', 'Connection: close\r\n'), { timeoutMs: 500 })
    expect(events).toEqual(['connection', 'request /1', 'request /2'])
  })
})

describe('malformed requests', () => {
  it.each([
    ['garbage', 'BLAH\r\n\r\n'],
    ['an unknown method', 'FOO /x HTTP/1.1\r\nHost: x\r\n\r\n'],
    ['a version Node does not speak', 'GET /x HTTP/9.9\r\nHost: x\r\n\r\n'],
    ['a length given twice', 'POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n'],
    ['a length that is not a number', 'POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: abc\r\n\r\n'],
    ['a header without a colon', 'GET /x HTTP/1.1\r\nHost: x\r\nBad\r\n\r\n']
  ])('answers %s with 400 and closes, without a request event', async (_name, bytes) => {
    let requests = 0
    const { port } = await startServer((_req, res) => { requests++; res.end() })
    const { data, closed } = await rawExchange(port, bytes)
    expect(data).toBe('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    expect(closed).toBe(true)
    expect(requests).toBe(0)
  })

  it('answers a bad chunk size with 400 once the request event has run, when nothing was answered yet', async () => {
    const { port } = await startServer((req) => { req.on('error', () => {}); req.resume() })
    const { data, closed } = await rawExchange(port, 'POST /x HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n')
    expect(data).toBe('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    expect(closed).toBe(true)
  })

  it('does not add a 400 behind a response it already started', async () => {
    const { port } = await startServer((_req, res) => { res.end('answered') })
    const { data } = await rawExchange(port, 'POST /x HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n')
    expect(data).toContain('answered')
    expect(data).not.toContain('400')
  })

  it('answers a head past maxHeaderSize with 431', async () => {
    const { port } = await startServer((_req, res) => { res.end() })
    const { data, closed } = await rawExchange(port, `GET /x HTTP/1.1\r\nHost: x\r\nX: ${'a'.repeat(20000)}\r\n\r\n`)
    expect(data).toBe('HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n')
    expect(closed).toBe(true)
  })

  it('answers an HTTP/1.1 request with no Host header with 400, as Node 24 does by default', async () => {
    const { port } = await startServer((_req, res) => { res.end('served') })
    const { data, closed } = await rawExchange(port, 'GET /x HTTP/1.1\r\n\r\n')
    expect(data).toContain('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n')
    expect(data).not.toContain('served')
    expect(closed).toBe(true)
  })

  it('lets an HTTP/1.0 request, or requireHostHeader: false, through without a Host', async () => {
    const { port } = await startServer((_req, res) => { res.end('served') })
    expect((await rawExchange(port, 'GET /x HTTP/1.0\r\n\r\n')).data).toContain('served')
    const relaxed = await startServer((_req, res) => { res.end('served') }, { requireHostHeader: false })
    expect((await rawExchange(relaxed.port, 'GET /x HTTP/1.1\r\n\r\n', { until: 'served' })).data).toContain('served')
  })

  it('emits clientError with a code and the socket, and leaves the answer to the listener', async () => {
    const { server, port } = await startServer((_req, res) => { res.end() })
    const errors: string[] = []
    server.on('clientError', (error: Error & { code?: string }, socket) => {
      errors.push(String(error.code))
      socket.end('HTTP/1.1 418 I\'m a teapot\r\nConnection: close\r\n\r\n')
    })
    const { data } = await rawExchange(port, 'BLAH\r\n\r\n')
    expect(errors).toEqual(['HPE_INVALID_METHOD'])
    expect(data).toContain('418')
    const overflow = await rawExchange(port, `GET / HTTP/1.1\r\nHost: x\r\nX: ${'a'.repeat(20000)}\r\n\r\n`)
    expect(overflow.data).toContain('418')
    expect(errors).toEqual(['HPE_INVALID_METHOD', 'HPE_HEADER_OVERFLOW'])
  })

  it('serves a good request after a bad one on a fresh connection', async () => {
    const { port } = await startServer((_req, res) => { res.end('fine') })
    await rawExchange(port, 'BLAH\r\n\r\n')
    expect((await fetchFrom(port, '/')).text).toBe('fine')
  })
})

describe('timeouts', () => {
  it('closes an idle keep-alive connection after keepAliveTimeout', async () => {
    const { port } = await startServer((_req, res) => { res.end('k') }, { keepAliveTimeout: 150 })
    const { data, closed } = await rawExchange(port, GET('/'), { timeoutMs: 1000 })
    expect(data).toContain('Keep-Alive: timeout=0')
    expect(closed).toBe(true)
  })

  it('answers 408 to a head that does not finish within headersTimeout', async () => {
    const { port } = await startServer((_req, res) => { res.end() }, { headersTimeout: 120 })
    const { data, closed } = await rawExchange(port, 'GET / HTTP/1.1\r\nHost: x\r\n', { timeoutMs: 1000 })
    expect(data).toBe('HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n')
    expect(closed).toBe(true)
  })

  it('answers 408 to a request that takes longer than requestTimeout to arrive', async () => {
    const { port } = await startServer((req) => { req.resume() }, { requestTimeout: 150 })
    const { data, closed } = await rawExchange(port, ['POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n', 'a'], { timeoutMs: 1000 })
    expect(data).toContain('HTTP/1.1 408 Request Timeout')
    expect(closed).toBe(true)
  })

  it('emits timeout on the server after server.timeout of silence, and closes the socket when nobody handles it', async () => {
    const { server, port } = await startServer((req) => { req.resume() }, { timeout: 100 })
    const seen: string[] = []
    const handler = (): void => { seen.push('timeout') }
    server.once('timeout', handler)
    await rawExchange(port, 'POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\n', { timeoutMs: 400 })
    expect(seen).toEqual(['timeout'])
    const { closed } = await rawExchange(port, 'POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\n', { timeoutMs: 1000 })
    expect(closed).toBe(true)
  })

  it('stores the timeout properties Node has, with Node\'s defaults', async () => {
    const { server } = await startServer()
    expect([server.timeout, server.keepAliveTimeout, server.headersTimeout, server.requestTimeout, server.maxHeadersCount, server.maxRequestsPerSocket, server.connectionsCheckingInterval])
      .toEqual([0, 5000, 60000, 300000, null, 0, 30000])
    expect(server.setTimeout(1234)).toBe(server)
    expect(server.timeout).toBe(1234)
  })
})

describe('streaming a large response', () => {
  it('honours backpressure: write() turns false and drain comes back, and a slow reader gets every byte', async () => {
    const chunk = Buffer.alloc(256 * 1024)
    for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 7) & 255
    const chunks = 96
    const expected = createHash('sha1')
    for (let i = 0; i < chunks; i++) expected.update(chunk)
    let falseWrites = 0
    let drains = 0
    let peakBuffered = 0
    const { port } = await startServer((_req, res) => {
      let sent = 0
      const pump = (): void => {
        while (sent < chunks) {
          sent++
          const ok = res.write(chunk)
          peakBuffered = Math.max(peakBuffered, res.writableLength)
          if (!ok) { falseWrites++; res.once('drain', () => { drains++; pump() }); return }
        }
        res.end()
      }
      pump()
    })
    const digest = createHash('sha1')
    let received = 0
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, agent: false }, (res) => {
        res.pause()
        setTimeout(() => res.resume(), 500)
        res.on('data', (c: Buffer) => { digest.update(c); received += c.length })
        res.on('end', resolve)
      })
      req.on('error', reject)
      req.end()
    })
    expect(received).toBe(chunk.length * chunks)
    expect(digest.digest('hex')).toBe(expected.digest('hex'))
    expect(falseWrites).toBeGreaterThan(0)
    expect(drains).toBe(falseWrites)
    expect(peakBuffered, 'the server never queued the whole 24 MB').toBeLessThan(chunk.length * chunks / 2)
  })
})

describe('server.close()', () => {
  it('lets a request in flight finish, then closes the connection and emits close', async () => {
    const events: string[] = []
    const { server, port } = await startServer((_req, res) => { setTimeout(() => res.end('done'), 200) })
    server.on('close', () => events.push('close'))
    const inflight = fetchFrom(port, '/')
    await waitFor(() => server.listenerCount('request') > 0 && server.getConnections !== undefined)
    await new Promise((r) => setTimeout(r, 60))
    server.close(() => events.push('close callback'))
    expect(server.listening).toBe(false)
    expect(server.address()).toBeNull()
    expect((await inflight).text).toBe('done')
    await waitFor(() => events.length === 2)
    expect(events).toEqual(['close', 'close callback'])
  })

  it('closes idle connections at once, and turns away one that connects while it is closing', async () => {
    const { server, port } = await startServer((_req, res) => { setTimeout(() => res.end('x'), 300) })
    const idle = connect(port, '127.0.0.1')
    await new Promise((r) => idle.once('connect', r))
    const busy = fetchFrom(port, '/')
    await new Promise((r) => setTimeout(r, 80))
    const idleClosed = new Promise<void>((resolve) => idle.once('close', () => resolve()))
    server.close()
    await idleClosed
    const late = await rawExchange(port, GET('/', 'Connection: close\r\n'), { timeoutMs: 300 }).catch(() => ({ data: '', closed: true }))
    expect(late.data).toBe('')
    expect((await busy).text).toBe('x')
  })

  it('closeAllConnections() drops a request in flight', async () => {
    const closes: string[] = []
    const { server, port } = await startServer((_req, res) => { res.on('close', () => closes.push('res close')) })
    const pending = rawExchange(port, GET('/'), { timeoutMs: 1500 })
    await new Promise((r) => setTimeout(r, 100))
    server.closeAllConnections()
    expect((await pending).closed).toBe(true)
    expect(closes).toEqual(['res close'])
  })

  it('reports a server that was never listening to the close callback', async () => {
    const server = createServer()
    const error = await new Promise<Error & { code?: string } | undefined>((resolve) => server.close((e) => resolve(e)))
    expect(error?.code).toBe('ERR_SERVER_NOT_RUNNING')
  })

  it('a second close() while the first waits for a request only adds a callback', async () => {
    const { server, port } = await startServer((_req, res) => { setTimeout(() => res.end('done'), 150) })
    const order: string[] = []
    const inflight = fetchFrom(port, '/')
    await new Promise((r) => setTimeout(r, 50))
    server.close(() => order.push('first'))
    server.close(() => order.push('second'))
    expect((await inflight).text).toBe('done')
    await waitFor(() => order.length === 2)
    expect(order).toEqual(['first', 'second'])
  })

  it('splitReply keeps the harness honest', () => {
    expect(splitReply('a\r\n\r\nb')).toEqual({ head: 'a', body: 'b' })
  })
})
