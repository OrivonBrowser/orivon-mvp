import { afterEach, describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { fetchFrom, rawExchange, splitReply, startServer, stopServers, waitFor } from '../../tests/support/http-server-harness.js'

afterEach(stopServers)

const GET = (path: string, extra = ''): string => `GET ${path} HTTP/1.1\r\nHost: x\r\n${extra}\r\n`

describe('ServerResponse: what goes on the wire', () => {
  it('answers with Content-Length when end() carries the whole body, and adds Date and Keep-Alive', async () => {
    const { port } = await startServer((_req, res) => { res.end('hello') })
    const { head, body } = splitReply((await rawExchange(port, GET('/'), { until: 'hello' })).data)
    expect(body).toBe('hello')
    const lines = head.split('\r\n')
    expect(lines[0]).toBe('HTTP/1.1 200 OK')
    expect(lines[1]).toMatch(/^Date: \w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/)
    expect(lines.slice(2)).toEqual(['Connection: keep-alive', 'Keep-Alive: timeout=5', 'Content-Length: 5'])
  })

  it('keeps the app\'s headers first and in the spelling it set them', async () => {
    const { port } = await startServer((_req, res) => {
      res.setHeader('X-Foo', 'A')
      res.setHeader('set-cookie', ['a=1', 'b=2'])
      res.writeHead(201, 'Made', { 'X-Bar': 'b' })
      res.end()
    })
    const { head } = splitReply((await rawExchange(port, GET('/', 'Connection: close\r\n'))).data)
    const lines = head.split('\r\n')
    expect(lines[0]).toBe('HTTP/1.1 201 Made')
    expect(lines.slice(1, 5)).toEqual(['X-Foo: A', 'set-cookie: a=1', 'set-cookie: b=2', 'X-Bar: b'])
    expect(lines.slice(6)).toEqual(['Connection: close', 'Transfer-Encoding: chunked'])
  })

  it('frames a body written in pieces as chunks, and ends them with the zero chunk', async () => {
    const { port } = await startServer((_req, res) => { res.write('a'); res.write('bc'); res.end('d') })
    const reply = (await rawExchange(port, GET('/'), { until: '0\r\n\r\n' })).data
    expect(reply).toContain('Transfer-Encoding: chunked\r\n\r\n1\r\na\r\n2\r\nbc\r\n1\r\nd\r\n0\r\n\r\n')
    expect(reply).not.toContain('Content-Length')
  })

  it('sends the head alone for HEAD, 204 and 304, even when the app writes a body', async () => {
    const { port } = await startServer((req, res) => {
      if (req.url === '/204') res.statusCode = 204
      if (req.url === '/304') res.statusCode = 304
      res.end('never sent')
    })
    for (const [method, path] of [['HEAD', '/'], ['GET', '/204'], ['GET', '/304']] as const) {
      const reply = (await rawExchange(port, `${method} ${path} HTTP/1.1\r\nHost: x\r\n\r\n`, { timeoutMs: 200 })).data
      const { head, body } = splitReply(reply)
      expect(body, `${method} ${path}`).toBe('')
      expect(head).not.toMatch(/Content-Length|Transfer-Encoding/)
    }
  })

  it('does not send Date once sendDate is turned off', async () => {
    const { port } = await startServer((_req, res) => { res.sendDate = false; res.end('x') })
    expect((await rawExchange(port, GET('/'), { until: '\r\n\r\nx' })).data).not.toContain('Date:')
  })

  it('honours a Content-Length the app set, and writes the body as given', async () => {
    const { port } = await startServer((_req, res) => { res.writeHead(200, { 'Content-Length': 3 }); res.write('ab'); res.end('c') })
    const reply = await fetchFrom(port, '/')
    expect(reply.headers['content-length']).toBe('3')
    expect(reply.text).toBe('abc')
  })

  it('honours Transfer-Encoding: chunked set by the app', async () => {
    const { port } = await startServer((_req, res) => { res.setHeader('Transfer-Encoding', 'chunked'); res.end('abc') })
    const reply = await fetchFrom(port, '/')
    expect(reply.headers['transfer-encoding']).toBe('chunked')
    expect(reply.text).toBe('abc')
  })

  it('answers a Buffer body and a non-UTF-8 string encoding byte for byte', async () => {
    const { port } = await startServer((req, res) => {
      if (req.url === '/latin1') res.end('café', 'latin1')
      else res.end(Buffer.from([0, 1, 2, 255]))
    })
    expect([...(await fetchFrom(port, '/')).body]).toEqual([0, 1, 2, 255])
    expect([...(await fetchFrom(port, '/latin1')).body]).toEqual([0x63, 0x61, 0x66, 0xe9])
  })

  it('sends the head with flushHeaders() before any body, chunked', async () => {
    let release = (): void => {}
    const { port } = await startServer((_req, res) => { res.flushHeaders(); release = () => { res.end('late') } })
    const early = await rawExchange(port, GET('/'), { until: '\r\n\r\n' })
    expect(early.data).toContain('Transfer-Encoding: chunked')
    expect(early.data).not.toContain('late')
    release()
  })

  it('writeContinue() sends the interim status ahead of the answer', async () => {
    const { port } = await startServer((_req, res) => { res.writeContinue(); res.end('x') })
    expect((await rawExchange(port, GET('/'), { until: '\r\n\r\nx' })).data.startsWith('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK')).toBe(true)
  })

  it('pipes a Readable into the response', async () => {
    const { port } = await startServer((_req, res) => { Readable.from(['one ', 'two ', 'three']).pipe(res) })
    expect((await fetchFrom(port, '/')).text).toBe('one two three')
  })
})

describe('ServerResponse: HTTP/1.0 clients', () => {
  it('answers close-delimited, without chunking or Content-Length, and closes', async () => {
    const { port } = await startServer((_req, res) => { res.end('hi') })
    const { data, closed } = await rawExchange(port, 'GET / HTTP/1.0\r\n\r\n')
    const { head, body } = splitReply(data)
    expect(head.split('\r\n')[0]).toBe('HTTP/1.1 200 OK')
    expect(head).toContain('Connection: close')
    expect(head).not.toMatch(/Content-Length|Transfer-Encoding/)
    expect(body).toBe('hi')
    expect(closed).toBe(true)
  })

  it('keeps the connection when the client asks and the app gave a Content-Length', async () => {
    const { port } = await startServer((_req, res) => { res.setHeader('Content-Length', '2'); res.end('ok') })
    const { data, closed } = await rawExchange(port, 'GET / HTTP/1.0\r\nConnection: keep-alive\r\n\r\n', { until: '\r\n\r\nok', timeoutMs: 300 })
    expect(data).toContain('Connection: keep-alive')
    expect(closed).toBe(false)
  })
})

describe('ServerResponse: Connection handling', () => {
  it('closes after the response when the client sent Connection: close', async () => {
    const { port } = await startServer((_req, res) => { res.end('x') })
    const { data, closed } = await rawExchange(port, GET('/', 'Connection: close\r\n'))
    expect(data).toContain('Connection: close')
    expect(closed).toBe(true)
  })

  it('closes after the response when the app set Connection: close, and leaves a header the app set alone', async () => {
    const { port } = await startServer((_req, res) => { res.setHeader('Connection', 'close'); res.end('x') })
    const { data, closed } = await rawExchange(port, GET('/'))
    expect(data.match(/Connection: close/g)).toHaveLength(1)
    expect(closed).toBe(true)
  })
})

describe('ServerResponse: events, state and errors', () => {
  it('emits finish then close, and reports its state on the way', async () => {
    const events: string[] = []
    const seen: Record<string, unknown> = {}
    const { port } = await startServer((_req, res) => {
      res.on('finish', () => { events.push('finish'); seen.finishedAtFinish = res.writableFinished })
      res.on('close', () => events.push('close'))
      seen.before = [res.headersSent, res.writableEnded, res.statusMessage]
      res.end('x', () => events.push('end callback'))
      seen.after = [res.headersSent, res.writableEnded, res.finished]
    })
    await fetchFrom(port, '/')
    await waitFor(() => events.includes('close'))
    expect(events).toEqual(['finish', 'end callback', 'close'])
    expect(seen.before).toEqual([false, false, undefined])
    expect(seen.after).toEqual([true, true, true])
    expect(seen.finishedAtFinish).toBe(true)
  })

  it('takes its status message from STATUS_CODES once the head is written, or the one the app gave', async () => {
    const { port } = await startServer((req, res) => {
      if (req.url === '/named') res.writeHead(200, 'Fine And Dandy')
      else res.statusCode = 404
      res.end()
    })
    expect((await fetchFrom(port, '/')).statusMessage).toBe('Not Found')
    expect((await fetchFrom(port, '/named')).statusMessage).toBe('Fine And Dandy')
  })

  it('writeHead takes headers as an object, a flat array (keeping duplicates) or an array of pairs', async () => {
    const { port } = await startServer((req, res) => {
      res.setHeader('X-Old', 'replaced')
      if (req.url === '/flat') res.writeHead(200, ['X-Old', 'new', 'X-A', '1', 'X-A', '2'])
      else if (req.url === '/pairs') res.writeHead(200, [['X-A', '1'], ['X-A', '2']])
      else res.writeHead(200, { 'X-A': ['1', '2'] })
      res.end()
    })
    for (const path of ['/flat', '/pairs', '/obj']) {
      const reply = await fetchFrom(port, path)
      expect(reply.rawHeaders.filter((_, index) => index % 2 === 0 && _ === 'X-A'), path).toHaveLength(2)
      expect(reply.headers['x-a'], path).toBe('1, 2')
    }
    expect((await fetchFrom(port, '/flat')).headers['x-old']).toBe('new')
  })

  it('the header API works before the head goes out: set, append, get, has, remove, names, setHeaders', async () => {
    const seen: unknown[] = []
    const { port } = await startServer((_req, res) => {
      res.setHeader('A-B', 'x')
      res.appendHeader('a-b', 'y')
      res.appendHeader('a-b', ['z'])
      res.setHeader('X-Num', 5)
      res.setHeaders(new Headers({ 'X-H': 'v' }))
      seen.push(res.getHeader('a-b'), res.getHeader('x-num'), res.hasHeader('A-B'), res.getHeaderNames(), res.getRawHeaderNames())
      seen.push(Object.getPrototypeOf(res.getHeaders()), res.getHeaders()['a-b'])
      res.removeHeader('x-h')
      seen.push(res.hasHeader('x-h'), res.getHeader('missing'))
      res.end()
    })
    const reply = await fetchFrom(port, '/')
    expect(seen).toEqual([['x', 'y', 'z'], 5, true, ['a-b', 'x-num', 'x-h'], ['A-B', 'X-Num', 'x-h'], null, ['x', 'y', 'z'], false, undefined])
    expect(reply.headers['a-b']).toBe('x, y, z')
    expect(reply.headers['x-num']).toBe('5')
    expect(reply.headers['x-h']).toBeUndefined()
  })

  it('refuses what Node refuses, with Node\'s classes and codes', async () => {
    const thrown: [string | undefined, string, string][] = []
    const attempt = (action: () => unknown): void => {
      try { action() } catch (e) { const err = e as Error & { code?: string }; thrown.push([err.code, err.name, err.message]) }
    }
    const { port } = await startServer((_req, res) => {
      attempt(() => res.setHeader('bad name', 'x'))
      attempt(() => res.setHeader('x', 'bad\nvalue'))
      attempt(() => res.setHeader('x', undefined as unknown as string))
      attempt(() => res.writeHead(99))
      attempt(() => res.writeHead('abc' as unknown as number))
      attempt(() => res.write(null as unknown as string))
      attempt(() => res.write(123 as unknown as string))
      res.end('x')
      attempt(() => res.setHeader('y', 'z'))
      attempt(() => res.removeHeader('y'))
      attempt(() => res.writeHead(200))
    })
    await fetchFrom(port, '/')
    expect(thrown.map(([code, name]) => `${code} ${name}`)).toEqual([
      'ERR_INVALID_HTTP_TOKEN TypeError', 'ERR_INVALID_CHAR TypeError', 'ERR_HTTP_INVALID_HEADER_VALUE TypeError',
      'ERR_HTTP_INVALID_STATUS_CODE RangeError', 'ERR_HTTP_INVALID_STATUS_CODE RangeError',
      'ERR_STREAM_NULL_VALUES TypeError', 'ERR_INVALID_ARG_TYPE TypeError',
      'ERR_HTTP_HEADERS_SENT Error', 'ERR_HTTP_HEADERS_SENT Error', 'ERR_HTTP_HEADERS_SENT Error'
    ])
    expect(thrown[0]?.[2]).toBe('Header name must be a valid HTTP token ["bad name"]')
    expect(thrown[7]?.[2]).toBe('Cannot set headers after they are sent to the client')
    expect(thrown[9]?.[2]).toBe('Cannot write headers after they are sent to the client')
  })

  it('a write after end() is an error event and false, and a second end() callback gets ERR_STREAM_ALREADY_FINISHED', async () => {
    const seen: unknown[] = []
    const { port } = await startServer((_req, res) => {
      res.on('error', (e: Error & { code?: string }) => seen.push(`error ${String(e.code)}`))
      res.end('x')
      seen.push(res.write('more', (e) => seen.push(`write callback ${String((e as { code?: string } | undefined)?.code)}`)))
      res.end((e) => seen.push(`end callback ${String((e as { code?: string } | undefined)?.code)}`))
    })
    expect((await fetchFrom(port, '/')).text).toBe('x')
    await waitFor(() => seen.length >= 4)
    expect(seen[0]).toBe(false)
    expect(seen).toEqual(expect.arrayContaining(['error ERR_STREAM_WRITE_AFTER_END', 'write callback ERR_STREAM_WRITE_AFTER_END', 'end callback ERR_STREAM_ALREADY_FINISHED']))
  })

  it('ends a HEAD response cleanly, and lets the app know a body is not sent', async () => {
    const { port } = await startServer((_req, res) => { res.write('ignored'); res.end() })
    const reply = await fetchFrom(port, '/', { method: 'HEAD' })
    expect(reply.status).toBe(200)
    expect(reply.text).toBe('')
  })

  it('addTrailers() sends trailers after the last chunk', async () => {
    const { port } = await startServer((_req, res) => {
      res.setHeader('Trailer', 'X-Sum')
      res.write('abc')
      res.addTrailers({ 'X-Sum': '42' })
      res.end()
    })
    expect((await rawExchange(port, GET('/'), { until: 'X-Sum: 42\r\n\r\n' })).data).toContain('3\r\nabc\r\n0\r\nX-Sum: 42\r\n\r\n')
  })

  it('writeEarlyHints() and writeProcessing() send interim statuses', async () => {
    const { port } = await startServer((_req, res) => { res.writeEarlyHints({ link: '</a.css>; rel=preload' }); res.writeProcessing(); res.end('x') })
    const data = (await rawExchange(port, GET('/'), { until: '\r\n\r\nx' })).data
    expect(data.startsWith('HTTP/1.1 103 Early Hints\r\nlink: </a.css>; rel=preload\r\n\r\nHTTP/1.1 102 Processing\r\n\r\nHTTP/1.1 200 OK')).toBe(true)
  })
})
