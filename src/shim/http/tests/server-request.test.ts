import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { request } from 'node:http'
import { Readable } from 'node:stream'
import type { IncomingMessage } from '../message.js'
import { fetchFrom, rawExchange, splitReply, startServer, stopServers, waitFor } from '../../tests/support/http-server-harness.js'

afterEach(stopServers)

async function readAll (req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const chunk of req) parts.push(chunk as Buffer)
  return Buffer.concat(parts)
}

describe('IncomingMessage on the server', () => {
  it('carries the request line, headers and connection as Node\'s does', async () => {
    let seen: Record<string, unknown> = {}
    const { server, port } = await startServer((req, res) => {
      seen = {
        method: req.method, url: req.url, httpVersion: req.httpVersion, major: req.httpVersionMajor, minor: req.httpVersionMinor,
        headers: req.headers, rawHeaders: req.rawHeaders, distinct: req.headersDistinct, complete: req.complete, upgrade: req.upgrade,
        sameSocket: req.connection === req.socket, server: req.socket && (req.socket as unknown as { server: unknown }).server === server,
        remote: (req.socket as { remoteAddress?: string }).remoteAddress
      }
      res.end()
    })
    await rawExchange(port, 'GET /path?q=1 HTTP/1.1\r\nHost: x\r\nX-A: 1\r\nx-a: 2\r\nCookie: a=1\r\n\r\n', { until: 'Content-Length: 0' })
    expect(seen).toMatchObject({
      method: 'GET', url: '/path?q=1', httpVersion: '1.1', major: 1, minor: 1, upgrade: false, sameSocket: true, server: true, remote: '127.0.0.1'
    })
    expect((seen.headers as Record<string, string>)['x-a']).toBe('1, 2')
    expect((seen.headers as Record<string, string>).cookie).toBe('a=1')
    expect(seen.rawHeaders).toEqual(expect.arrayContaining(['X-A', '1', 'x-a', '2']))
    expect((seen.distinct as Record<string, string[]>)['x-a']).toEqual(['1', '2'])
  })

  it('reads a Content-Length body, by events, by async iteration and with an encoding', async () => {
    const seen: string[] = []
    const { port } = await startServer((req, res) => {
      if (req.url === '/iter') { void readAll(req).then((body) => { seen.push(`iter ${body.toString()}`); res.end() }); return }
      if (req.url === '/enc') { req.setEncoding('utf8'); let text = ''; req.on('data', (c: string) => { text += c }); req.on('end', () => { seen.push(`enc ${text} ${String(req.complete)}`); res.end() }); return }
      let bytes = 0
      req.on('data', (c: Buffer) => { bytes += c.length })
      req.on('end', () => { seen.push(`events ${bytes}`); res.end() })
    })
    await fetchFrom(port, '/events', { method: 'POST', body: 'abcdef' })
    await fetchFrom(port, '/iter', { method: 'POST', body: 'hello' })
    await fetchFrom(port, '/enc', { method: 'POST', body: 'café' })
    expect(seen).toEqual(['events 6', 'iter hello', 'enc café true'])
  })

  it('reads a chunked request body, with trailers', async () => {
    let seen: unknown[] = []
    const { port } = await startServer((req, res) => {
      void readAll(req).then((body) => { seen = [body.toString(), req.trailers, req.rawTrailers]; res.end() })
    })
    await rawExchange(port, 'POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n3;ext=1\r\ndef\r\n0\r\nX-T: 1\r\n\r\n', { until: '\r\n\r\n' })
    expect(seen).toEqual(['abcdef', { 'x-t': '1' }, ['X-T', '1']])
  })

  it('reads a body that arrives in awkward pieces', async () => {
    let body = ''
    const { port } = await startServer((req, res) => { void readAll(req).then((b) => { body = b.toString(); res.end() }) })
    await rawExchange(port, ['POST /p HTTP/1.1\r\nHo', 'st: x\r\nContent-Le', 'ngth: 6\r\n\r\nab', 'cdef'], { until: 'Content-Length: 0' })
    expect(body).toBe('abcdef')
  })

  it('echoes a megabyte through req.pipe(res), byte for byte', async () => {
    const payload = Buffer.alloc(1024 * 1024)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 255
    const { port } = await startServer((req, res) => { req.pipe(res) })
    const reply = await fetchFrom(port, '/', { method: 'POST', body: payload })
    expect(reply.body.equals(payload)).toBe(true)
  })

  it('applies backpressure: a body nobody reads does not pile up in memory, and arrives intact once read', async () => {
    const chunk = Buffer.alloc(64 * 1024, 7)
    const total = 512
    let produced = 0
    const source = Readable.from((function * () { for (let i = 0; i < total; i++) { produced++; yield chunk } })())
    const hash = createHash('sha1')
    for (let i = 0; i < total; i++) hash.update(chunk)
    let started: (req: IncomingMessage) => void = () => {}
    const reading = new Promise<IncomingMessage>((resolve) => { started = resolve })
    const { port } = await startServer((req) => { started(req) })
    const outcome = new Promise<string>((resolve, reject) => {
      const client = request({ host: '127.0.0.1', port, method: 'POST', agent: false, headers: { 'Content-Length': String(chunk.length * total) } }, (res) => {
        let text = ''
        res.on('data', (c: Buffer) => { text += c.toString() })
        res.on('end', () => resolve(text))
      })
      client.on('error', reject)
      source.pipe(client)
    })
    const req = await reading
    await new Promise((r) => setTimeout(r, 400))
    expect(produced, 'the client is held back while the server does not read').toBeLessThan(total)
    expect(req.readableLength).toBeLessThan(2 * 1024 * 1024)
    const digest = createHash('sha1')
    let received = 0
    req.on('data', (c: Buffer) => { digest.update(c); received += c.length })
    req.on('end', () => { (req as unknown as { socket: { server: unknown } }).socket.server; })
    await new Promise<void>((resolve) => req.on('end', resolve))
    expect(received).toBe(chunk.length * total)
    expect(digest.digest('hex')).toBe(hash.digest('hex'))
    void outcome.catch(() => {})
  })

  it('reports a client that vanishes mid-body: aborted, an error when someone listens, close on both sides', async () => {
    const events: string[] = []
    const { port } = await startServer((req, res) => {
      req.on('aborted', () => events.push('req aborted'))
      req.on('error', (e: Error & { code?: string }) => events.push(`req error ${String(e.code)} ${e.message}`))
      req.on('close', () => events.push(`req close complete=${String(req.complete)} aborted=${String(req.aborted)}`))
      res.on('close', () => events.push('res close'))
      req.resume()
    })
    await rawExchange(port, 'POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 10\r\n\r\nabc', { timeoutMs: 100 })
    await waitFor(() => events.length >= 4)
    expect(events).toEqual(expect.arrayContaining(['req aborted', 'req error ECONNRESET aborted', 'req close complete=false aborted=true', 'res close']))
  })

  it('does not throw an unhandled error for an aborted request nobody listens to', async () => {
    let closed = false
    const { port } = await startServer((req) => { req.on('close', () => { closed = true }) })
    await rawExchange(port, 'POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 10\r\n\r\nabc', { timeoutMs: 100 })
    await waitFor(() => closed)
  })

  it('keeps res and req usable after the client is gone: the response just goes nowhere', async () => {
    const outcome: unknown[] = []
    const { port } = await startServer((req, res) => {
      res.on('close', () => { outcome.push(res.write('late'), res.writableFinished); res.end() })
      req.resume()
    })
    await rawExchange(port, 'GET / HTTP/1.1\r\nHost: x\r\n\r\n', { timeoutMs: 100 })
    await waitFor(() => outcome.length === 2)
    expect(outcome).toEqual([false, false])
  })

  it('tears a connection down when the client half-closes while the handler works, as Node does: aborted, res close, no answer', async () => {
    const events: string[] = []
    const { port } = await startServer((req, res) => {
      req.on('aborted', () => events.push('req aborted'))
      res.on('close', () => events.push('res close'))
      setTimeout(() => res.end('late'), 250)
    })
    const { data, closed } = await rawExchange(port, 'GET / HTTP/1.1\r\nHost: x\r\n\r\n', { endAfter: true, timeoutMs: 500 })
    expect(closed).toBe(true)
    expect(data).toBe('')
    expect(events).toEqual(['req aborted', 'res close'])
  })

  it('answers 400 to a request the client cut off part-way with a FIN', async () => {
    const { port } = await startServer((req) => { req.resume() })
    const { data, closed } = await rawExchange(port, 'POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 10\r\n\r\nabc', { endAfter: true })
    expect(data).toBe('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    expect(closed).toBe(true)
  })

  it('discards the rest of a body the app never read, then serves the next request on the connection', async () => {
    const { port } = await startServer((req, res) => { res.end(`r ${req.url}`) })
    const { data } = await rawExchange(port, [
      'POST /first HTTP/1.1\r\nHost: x\r\nContent-Length: 20\r\n\r\n0123456789',
      '0123456789GET /second HTTP/1.1\r\nHost: x\r\n\r\n'
    ], { until: 'r /second' })
    expect(data).toContain('r /first')
    expect(data).toContain('r /second')
  })

  it('closes right after a Connection: close response without waiting for the rest of the body', async () => {
    const { port } = await startServer((_req, res) => { res.statusCode = 413; res.setHeader('Connection', 'close'); res.end('too big') })
    const { data, closed } = await rawExchange(port, 'POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\nabc')
    expect(splitReply(data).head).toContain('HTTP/1.1 413 Payload Too Large')
    expect(closed).toBe(true)
  })
})

describe('Expect: 100-continue', () => {
  it('sends 100 Continue by itself when nobody listens for checkContinue, then the request event', async () => {
    let body = ''
    const { port } = await startServer((req, res) => { void readAll(req).then((b) => { body = b.toString(); res.end('done') }) })
    const continued = await new Promise<boolean>((resolve, reject) => {
      const client = request({ host: '127.0.0.1', port, method: 'POST', agent: false, headers: { Expect: '100-continue', 'Content-Length': '5' } })
      client.on('continue', () => { client.end('hello'); resolve(true) })
      client.on('response', (res) => res.resume())
      client.on('error', reject)
      client.flushHeaders()
    })
    expect(continued).toBe(true)
    await waitFor(() => body === 'hello')
  })

  it('hands the decision to checkContinue listeners and does not emit request unless they do', async () => {
    const seen: string[] = []
    const { server, port } = await startServer(() => { seen.push('request') })
    server.on('checkContinue', (_req, res) => { seen.push('checkContinue'); res.writeHead(417); res.end() })
    const { data } = await rawExchange(port, 'POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 3\r\nExpect: 100-continue\r\n\r\n', { until: '417' })
    expect(data).toContain('HTTP/1.1 417')
    expect(seen).toEqual(['checkContinue'])
  })

  it('answers any other expectation with 417, or hands it to checkExpectation', async () => {
    const { server, port } = await startServer((_req, res) => { res.end() })
    const refused = await rawExchange(port, 'POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nExpect: foo\r\n\r\n', { until: '417' })
    expect(refused.data).toContain('HTTP/1.1 417 Expectation Failed')
    server.on('checkExpectation', (_req, res) => { res.writeHead(418); res.end() })
    const handled = await rawExchange(port, 'POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nExpect: foo\r\n\r\n', { until: '418' })
    expect(handled.data).toContain('HTTP/1.1 418')
  })
})
