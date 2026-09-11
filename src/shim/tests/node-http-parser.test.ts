import { describe, expect, it } from 'vitest'
import { HttpResponseParser, concatBytes, type ParsedResponseHead } from '../node-http-parser.js'

const enc = new TextEncoder()

function makeParser (method = 'GET') {
  const heads: ParsedResponseHead[] = []
  const body: Uint8Array[] = []
  const errors: Error[] = []
  let completeCount = 0
  const parser = new HttpResponseParser({
    onHead: (h) => heads.push(h),
    onBody: (chunk) => body.push(chunk),
    onComplete: () => { completeCount++ },
    onError: (e) => errors.push(e)
  }, { method })
  return {
    parser,
    heads,
    errors,
    get complete () { return completeCount },
    bodyText: () => new TextDecoder().decode(body.reduce(concatBytes, new Uint8Array(0)))
  }
}

describe('HttpResponseParser -- content-length body', () => {
  it('parses status line, headers and a full body delivered in one push', () => {
    const h = makeParser()
    h.parser.write(enc.encode('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhello'))

    expect(h.heads).toHaveLength(1)
    expect(h.heads[0]).toMatchObject({ httpVersion: '1.1', statusCode: 200, statusMessage: 'OK' })
    expect(h.heads[0]?.headers['content-type']).toBe('text/plain')
    expect(h.bodyText()).toBe('hello')
    expect(h.complete).toBe(1)
    expect(h.errors).toHaveLength(0)
  })

  it('parses a response split across many tiny pushes, byte by byte', () => {
    const h = makeParser()
    const whole = enc.encode('HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc')
    for (const byte of whole) h.parser.write(new Uint8Array([byte]))

    expect(h.heads).toHaveLength(1)
    expect(h.bodyText()).toBe('abc')
    expect(h.complete).toBe(1)
  })

  it('treats Content-Length: 0 as an immediately complete, bodyless response', () => {
    const h = makeParser()
    h.parser.write(enc.encode('HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n'))
    expect(h.complete).toBe(1)
    expect(h.bodyText()).toBe('')
  })
})

describe('HttpResponseParser -- chunked body', () => {
  it('decodes a multi-chunk body, stripping size lines and trailing CRLFs', () => {
    const h = makeParser()
    const wire = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n' +
      '5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n'
    h.parser.write(enc.encode(wire))

    expect(h.bodyText()).toBe('hello world')
    expect(h.complete).toBe(1)
  })

  it('decodes chunked data arriving in fragments that split a chunk boundary', () => {
    const h = makeParser()
    const wire = enc.encode('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n')
    // Split partway through the "3\r\nab" boundary, forcing the parser to
    // resume mid-chunk on the next write().
    h.parser.write(wire.subarray(0, 40))
    h.parser.write(wire.subarray(40))

    expect(h.bodyText()).toBe('abc')
    expect(h.complete).toBe(1)
  })

  it('discards trailer headers after the terminating zero-length chunk', () => {
    const h = makeParser()
    const wire = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n' +
      '2\r\nhi\r\n0\r\nX-Trailer: ignored\r\n\r\n'
    h.parser.write(enc.encode(wire))
    expect(h.bodyText()).toBe('hi')
    expect(h.complete).toBe(1)
  })

  it('discards several real trailer headers before the terminating blank line', () => {
    const h = makeParser()
    const wire = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n' +
      '2\r\nhi\r\n0\r\nX-Checksum: abc123\r\nX-Trace-Id: req-42\r\n\r\n'
    h.parser.write(enc.encode(wire))
    expect(h.bodyText()).toBe('hi')
    expect(h.complete).toBe(1)
    expect(h.errors).toHaveLength(0)
  })

  it('parses a large but valid chunked body delivered as a single write', () => {
    const h = makeParser()
    h.parser.write(enc.encode('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n'))

    const payload = 'x'.repeat(100 * 1024)
    const wire = payload.length.toString(16) + '\r\n' + payload + '\r\n0\r\n\r\n'
    // The chunk-size line itself is tiny, but the whole buffer it arrives in
    // (line + 100 KiB of body, all one write()) is far bigger than the new
    // line-length bound -- this is the case a naive "bound the whole buffer"
    // fix would have broken.
    h.parser.write(enc.encode(wire))

    expect(h.bodyText()).toBe(payload)
    expect(h.complete).toBe(1)
    expect(h.errors).toHaveLength(0)
  })

  it('parses a large valid chunked body streamed across many small pumps', () => {
    const h = makeParser()
    const payload = 'y'.repeat(50 * 1024)
    const head = enc.encode('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n')
    const wire = enc.encode(payload.length.toString(16) + '\r\n' + payload + '\r\n0\r\n\r\n')
    h.parser.write(head)
    // Drip the body in 4 KiB pumps, well under the per-line bound each time,
    // to prove the bound only fires on an unterminated line, not on steady
    // legitimate growth.
    for (let i = 0; i < wire.length; i += 4096) h.parser.write(wire.subarray(i, i + 4096))

    expect(h.bodyText()).toBe(payload)
    expect(h.complete).toBe(1)
    expect(h.errors).toHaveLength(0)
  })
})

describe('HttpResponseParser -- unbounded line guard', () => {
  it('fails a chunk-size line that never terminates, instead of growing forever', () => {
    const h = makeParser()
    h.parser.write(enc.encode('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n'))

    // Hex-looking bytes with no CRLF, pumped in small writes the way a real
    // socket read loop would deliver them -- none of them make progress, so
    // the buffer would grow without bound if the parser did not step in.
    const junk = enc.encode('a'.repeat(1024))
    for (let i = 0; i < 12 && h.errors.length === 0; i++) h.parser.write(junk)

    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]?.message).toMatch(/chunk size line exceeded/)
    expect(h.complete).toBe(0)

    // The parser is done; further bytes are dropped rather than reopening it.
    h.parser.write(junk)
    expect(h.errors).toHaveLength(1)
  })

  it('fails a trailer line that never terminates, instead of growing forever', () => {
    const h = makeParser()
    h.parser.write(enc.encode('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n'))

    const junk = enc.encode('X-Junk: '.repeat(128))
    for (let i = 0; i < 12 && h.errors.length === 0; i++) h.parser.write(junk)

    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]?.message).toMatch(/trailer line exceeded/)
    expect(h.complete).toBe(0)
  })
})

describe('HttpResponseParser -- connection-close-terminated body', () => {
  it('treats every byte as body until end() when there is no length or chunking', () => {
    const h = makeParser()
    h.parser.write(enc.encode('HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n'))
    h.parser.write(enc.encode('part one '))
    h.parser.write(enc.encode('part two'))
    expect(h.complete).toBe(0)
    h.parser.end()
    expect(h.bodyText()).toBe('part one part two')
    expect(h.complete).toBe(1)
  })
})

describe('HttpResponseParser -- header combining', () => {
  it('joins duplicate headers with ", "', () => {
    const h = makeParser()
    h.parser.write(enc.encode('HTTP/1.1 200 OK\r\nX-A: one\r\nX-A: two\r\nContent-Length: 0\r\n\r\n'))
    expect(h.heads[0]?.headers['x-a']).toBe('one, two')
  })

  it('collects repeated Set-Cookie headers into an array instead of joining them', () => {
    const h = makeParser()
    h.parser.write(enc.encode('HTTP/1.1 200 OK\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nContent-Length: 0\r\n\r\n'))
    expect(h.heads[0]?.headers['set-cookie']).toEqual(['a=1', 'b=2'])
  })

  it('lowercases header names in `headers` but preserves original case in `rawHeaders`', () => {
    const h = makeParser()
    h.parser.write(enc.encode('HTTP/1.1 200 OK\r\nX-Custom-Header: Value\r\n\r\n'))
    expect(h.heads[0]?.headers['x-custom-header']).toBe('Value')
    expect(h.heads[0]?.rawHeaders).toEqual(['X-Custom-Header', 'Value'])
  })
})

describe('HttpResponseParser -- no-body responses', () => {
  it('gives a HEAD request no body regardless of Content-Length', () => {
    const h = makeParser('HEAD')
    h.parser.write(enc.encode('HTTP/1.1 200 OK\r\nContent-Length: 500\r\n\r\n'))
    expect(h.complete).toBe(1)
    expect(h.bodyText()).toBe('')
  })

  it('gives a 304 Not Modified no body', () => {
    const h = makeParser()
    h.parser.write(enc.encode('HTTP/1.1 304 Not Modified\r\nContent-Length: 500\r\n\r\n'))
    expect(h.complete).toBe(1)
    expect(h.bodyText()).toBe('')
  })
})

describe('HttpResponseParser -- malformed input and premature EOF', () => {
  it('reports an error on an unparseable status line', () => {
    const h = makeParser()
    h.parser.write(enc.encode('not an http response\r\n\r\n'))
    expect(h.errors).toHaveLength(1)
  })

  it('reports an error on a malformed chunk size', () => {
    const h = makeParser()
    h.parser.write(enc.encode('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n'))
    expect(h.errors).toHaveLength(1)
  })

  it('reports an error when the socket ends mid-body, short of Content-Length', () => {
    const h = makeParser()
    h.parser.write(enc.encode('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc'))
    h.parser.end()
    expect(h.errors).toHaveLength(1)
    expect(h.complete).toBe(0)
  })

  it('reports an error when the socket ends before any headers arrive', () => {
    const h = makeParser()
    h.parser.write(enc.encode('HTTP/1.1 200'))
    h.parser.end()
    expect(h.errors).toHaveLength(1)
  })
})
