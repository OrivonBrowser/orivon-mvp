import { describe, expect, it } from 'vitest'
import { HttpRequestParser, type ParsedRequestHead } from '../request-parser.js'

interface Seen { heads: ParsedRequestHead[], body: string[], complete: number, errors: string[], trailers: string[][], upgrades: { head: ParsedRequestHead, rest: string }[] }

function parse (chunks: readonly string[], options: { upgrade?: boolean, maxHeaderSize?: number } = {}): { seen: Seen, parser: HttpRequestParser } {
  const seen: Seen = { heads: [], body: [], complete: 0, errors: [], trailers: [], upgrades: [] }
  const parser = new HttpRequestParser({
    onHead: (head) => { seen.heads.push(head) },
    onBody: (chunk) => { seen.body.push(new TextDecoder().decode(chunk)) },
    onTrailers: (lines) => { seen.trailers.push([...lines]) },
    onComplete: () => { seen.complete++ },
    onError: (error) => { seen.errors.push(error.code) },
    isUpgrade: () => options.upgrade === true,
    onUpgrade: (head, rest) => { seen.upgrades.push({ head, rest: new TextDecoder().decode(rest) }) }
  }, options.maxHeaderSize === undefined ? {} : { maxHeaderSize: options.maxHeaderSize })
  for (const chunk of chunks) parser.write(new TextEncoder().encode(chunk))
  return { seen, parser }
}

describe('HttpRequestParser: the head', () => {
  it('parses a request line and headers into the shape IncomingMessage carries', () => {
    const { seen } = parse(['GET /a?b=1 HTTP/1.1\r\nHost: x\r\nX-Two:  padded  \r\n\r\n'])
    expect(seen.heads).toEqual([{
      method: 'GET', url: '/a?b=1', httpVersion: '1.1',
      headers: { host: 'x', 'x-two': 'padded' }, rawHeaders: ['Host', 'x', 'X-Two', 'padded']
    }])
    expect(seen.complete).toBe(1)
  })

  it('joins repeated headers as Node does for a request: cookies with "; ", set-cookie as an array, discrete names keep the first', () => {
    const { seen } = parse(['GET / HTTP/1.1\r\nX-A: 1\r\nx-a: 2\r\nCookie: a=1\r\nCookie: b=2\r\nSet-Cookie: q\r\nSet-Cookie: r\r\nUser-Agent: u1\r\nUser-Agent: u2\r\nHost: h1\r\nHost: h2\r\n\r\n'])
    expect(seen.heads[0]?.headers).toEqual({ 'x-a': '1, 2', cookie: 'a=1; b=2', 'set-cookie': ['q', 'r'], 'user-agent': 'u1', host: 'h1' })
  })

  it('assembles a head that arrives a byte at a time', () => {
    const text = 'POST /p HTTP/1.0\r\nContent-Length: 2\r\n\r\nok'
    const { seen } = parse([...text])
    expect(seen.heads[0]?.method).toBe('POST')
    expect(seen.heads[0]?.httpVersion).toBe('1.0')
    expect(seen.body.join('')).toBe('ok')
    expect(seen.complete).toBe(1)
  })

  it('skips blank lines a client left before a request', () => {
    expect(parse(['\r\n\r\nGET / HTTP/1.1\r\nHost: x\r\n\r\n']).seen.heads).toHaveLength(1)
  })

  it.each([
    ['garbage', 'BLAH\r\n\r\n', 'HPE_INVALID_METHOD'],
    ['unknown method', 'FOO / HTTP/1.1\r\n\r\n', 'HPE_INVALID_METHOD'],
    ['lower-case method', 'get / HTTP/1.1\r\n\r\n', 'HPE_INVALID_METHOD'],
    ['unsupported version', 'GET / HTTP/9.9\r\n\r\n', 'HPE_INVALID_VERSION'],
    ['space in the target', 'GET /a b HTTP/1.1\r\n\r\n', 'HPE_INVALID_URL'],
    ['header without a colon', 'GET / HTTP/1.1\r\nBad\r\n\r\n', 'HPE_INVALID_HEADER_TOKEN'],
    ['space before the colon', 'GET / HTTP/1.1\r\nA : b\r\n\r\n', 'HPE_INVALID_HEADER_TOKEN'],
    ['a folded header', 'GET / HTTP/1.1\r\nA: b\r\n c\r\n\r\n', 'HPE_INVALID_HEADER_TOKEN'],
    ['both length and chunking', 'POST / HTTP/1.1\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n', 'HPE_UNEXPECTED_CONTENT_LENGTH'],
    ['a repeated Content-Length', 'POST / HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\n', 'HPE_UNEXPECTED_CONTENT_LENGTH'],
    ['a Content-Length that is not a number', 'POST / HTTP/1.1\r\nContent-Length: abc\r\n\r\n', 'HPE_INVALID_CONTENT_LENGTH'],
    ['a coding that does not end in chunked', 'POST / HTTP/1.1\r\nTransfer-Encoding: gzip\r\n\r\n', 'HPE_INVALID_TRANSFER_ENCODING']
  ])('rejects %s with llhttp\'s code', (_name, text, code) => {
    const { seen, parser } = parse([text])
    expect(seen.errors).toEqual([code])
    expect(seen.heads).toHaveLength(0)
    expect(parser.finished).toBe(true)
  })

  it('fails a head past the size cap with HPE_HEADER_OVERFLOW, terminated or not', () => {
    expect(parse([`GET / HTTP/1.1\r\nX: ${'a'.repeat(200)}`], { maxHeaderSize: 100 }).seen.errors).toEqual(['HPE_HEADER_OVERFLOW'])
    expect(parse([`GET / HTTP/1.1\r\nX: ${'a'.repeat(200)}\r\n\r\n`], { maxHeaderSize: 100 }).seen.errors).toEqual(['HPE_HEADER_OVERFLOW'])
  })

  it('accepts a body-carrying head whose bytes share a write with a large body, without tripping the head cap', () => {
    const body = 'x'.repeat(500)
    const { seen } = parse([`POST / HTTP/1.1\r\nContent-Length: 500\r\n\r\n${body}`], { maxHeaderSize: 100 })
    expect(seen.errors).toEqual([])
    expect(seen.body.join('')).toBe(body)
  })
})

describe('HttpRequestParser: the body', () => {
  it('has none without Content-Length or chunking, and completes at the head', () => {
    const { seen } = parse(['GET / HTTP/1.1\r\nHost: x\r\n\r\n'])
    expect(seen.body).toEqual([])
    expect(seen.complete).toBe(1)
  })

  it('reads exactly Content-Length bytes and hands back what follows as the next request', () => {
    const { seen, parser } = parse(['POST / HTTP/1.1\r\nContent-Length: 3\r\n\r\nabcGET /next HTTP/1.1\r\n\r\n'])
    expect(seen.body.join('')).toBe('abc')
    expect(seen.complete).toBe(1)
    expect(parser.finished).toBe(true)
    expect(new TextDecoder().decode(parser.takeRest())).toBe('GET /next HTTP/1.1\r\n\r\n')
    expect(parser.takeRest()).toHaveLength(0)
  })

  it('decodes chunks with extensions and collects the trailers', () => {
    const { seen } = parse(['POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n3;ext=1\r\ndef\r\n0\r\nX-T: 1\r\n\r\n'])
    expect(seen.body.join('')).toBe('abcdef')
    expect(seen.trailers).toEqual([['X-T: 1']])
    expect(seen.complete).toBe(1)
  })

  it('bounds the trailer section by the header size, as Node does: many short lines, one huge line, and an unterminated one all fail with HPE_HEADER_OVERFLOW', () => {
    const start = 'POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n'
    const flood = Array.from({ length: 3000 }, (_, i) => `X-T${String(i)}: ${'v'.repeat(20)}\r\n`).join('')
    expect(parse([start, flood, '\r\n'], { maxHeaderSize: 1024 }).seen.errors).toEqual(['HPE_HEADER_OVERFLOW'])
    expect(parse([`${start}X: ${'a'.repeat(3000)}\r\n\r\n`], { maxHeaderSize: 1024 }).seen.errors).toEqual(['HPE_HEADER_OVERFLOW'])
    const unterminated = parse([start, 'X: '.repeat(600)], { maxHeaderSize: 1024 })
    expect(unterminated.seen.errors).toEqual(['HPE_HEADER_OVERFLOW'])
    expect(unterminated.seen.complete).toBe(0)
  })

  it('accepts a trailer section within the bound', () => {
    const { seen } = parse(['POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX-A: 1\r\nX-B: 2\r\n\r\n'], { maxHeaderSize: 1024 })
    expect(seen.errors).toEqual([])
    expect(seen.trailers).toEqual([['X-A: 1', 'X-B: 2']])
    expect(seen.complete).toBe(1)
  })

  it('fails a chunk size that is not hexadecimal', () => {
    expect(parse(['POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n']).seen.errors).toEqual(['HPE_INVALID_CHUNK_SIZE'])
  })

  it('reports a message that stops part-way as midMessage, and a finished one as not', () => {
    expect(parse(['GET / HT']).parser.midMessage).toBe(true)
    expect(parse(['POST / HTTP/1.1\r\nContent-Length: 5\r\n\r\nab']).parser.midMessage).toBe(true)
    expect(parse(['GET / HTTP/1.1\r\n\r\n']).parser.midMessage).toBe(false)
    expect(new HttpRequestParser({ onHead () {}, onBody () {}, onComplete () {}, onError () {} }).midMessage).toBe(false)
  })
})

describe('HttpRequestParser: upgrades', () => {
  it('hands the connection over with the bytes behind the head when the caller says so', () => {
    const { seen, parser } = parse(['GET /ws HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nFRAME'], { upgrade: true })
    expect(seen.heads).toHaveLength(0)
    expect(seen.upgrades).toHaveLength(1)
    expect(seen.upgrades[0]?.rest).toBe('FRAME')
    expect(seen.upgrades[0]?.head.headers.upgrade).toBe('websocket')
    expect(parser.finished).toBe(true)
  })

  it('treats the same request as an ordinary one when the caller declines', () => {
    const { seen } = parse(['GET /ws HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'])
    expect(seen.heads).toHaveLength(1)
    expect(seen.upgrades).toHaveLength(0)
  })
})
