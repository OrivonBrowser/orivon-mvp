// url, querystring and string_decoder, each checked against Node's own
// module on the same input rather than against expectations written here.

import * as nodeQuerystring from 'node:querystring'
import { StringDecoder as NodeStringDecoder } from 'node:string_decoder'
import * as nodeUrl from 'node:url'
import { describe, expect, it } from 'vitest'
import querystring from '../querystring.js'
import { StringDecoder } from '../string-decoder.js'
import url, { fileURLToPath, format, parse, pathToFileURL, resolve, Url, URL as ShimURL, URLSearchParams as ShimURLSearchParams } from '../url.js'

describe('url', () => {
  it('URL and URLSearchParams are the platform\'s', () => {
    expect(ShimURL).toBe(globalThis.URL)
    expect(ShimURLSearchParams).toBe(globalThis.URLSearchParams)
  })

  it.each(['/orivon/app/a b.txt', '/x/%/y#?'])('fileURLToPath/pathToFileURL round-trip %s as Node does', (path) => {
    expect(pathToFileURL(path).href).toBe(nodeUrl.pathToFileURL(path).href)
    expect(fileURLToPath(pathToFileURL(path))).toBe(path)
    expect(fileURLToPath(pathToFileURL(path).href)).toBe(path)
  })

  it('fileURLToPath refuses a non-file URL', () => {
    expect(() => fileURLToPath('https://example.com/x')).toThrow(expect.objectContaining({ code: 'ERR_INVALID_URL_SCHEME' }))
  })

  it.each([
    'https://user:pw@example.com:8080/p/a/t/h?query=string&a=1#hash',
    'http://example.com',
    '/relative/path?x=1#frag',
    'mailto:someone@example.com',
    'http://h/16 - Artist - Title.mp3',
    'http://h/a"b?q="x y"#h ash',
    'http://h/{a}|b^c`d',
    'http://h/a<b>\\c?d\\e',
    "http://h/it's",
    '/rel path?x=1 2',
    'http://h/a%20b',
    'javascript:alert("a b")'
  ])('legacy parse(%s) matches Node', (input) => {
    const ours = parse(input)
    const node = nodeUrl.parse(input)
    for (const key of ['protocol', 'slashes', 'auth', 'host', 'port', 'hostname', 'hash', 'search', 'query', 'pathname', 'path', 'href'] as const) {
      expect(ours[key], key).toEqual(node[key])
    }
  })

  const NodeUrlClass = (nodeUrl as unknown as { Url: new () => object }).Url

  it('legacy Url: parse returns one, and a bare `new Url()` has Node\'s twelve null-or-empty own fields', () => {
    expect(parse('/x?y=1')).toBeInstanceOf(Url)
    expect(url.Url).toBe(Url)
    expect(Object.keys(new Url())).toEqual(Object.keys(new NodeUrlClass()))
    expect(Object.getOwnPropertyNames(Url.prototype)).toEqual(Object.getOwnPropertyNames(NodeUrlClass.prototype))
    expect(new Url().parse('http://a.test/p?q=1').pathname).toBe('/p')
    const withHost = Object.assign(new Url(), { host: 'a.test:81' })
    withHost.parseHost()
    expect([withHost.host, withHost.port, withHost.hostname]).toEqual(['a.test:81', '81', 'a.test'])
  })

  it('parseurl\'s own construction shape works: a Url given only path, href, pathname, query and search', () => {
    const parsed = new Url()
    parsed.path = '/a?b=1'
    parsed.href = '/a?b=1'
    parsed.pathname = '/a'
    parsed.query = 'b=1'
    parsed.search = '?b=1'
    expect(parsed.protocol).toBeNull()
    expect(format(parsed)).toBe('/a?b=1')
  })

  it('legacy parse with parseQueryString gives an object query', () => {
    expect(parse('/p?a=1&a=2&b=x', true).query).toEqual({ a: ['1', '2'], b: 'x' })
  })

  it.each([
    ['/one/two/three', 'four'],
    ['http://example.com/', '/one'],
    ['http://example.com/one', '/two'],
    ['http://example.com/a/b', '../c'],
    ['one/two', 'three']
  ])('resolve(%s, %s) matches Node', (from, to) => {
    expect(resolve(from, to)).toBe(nodeUrl.resolve(from, to))
  })

  it('format takes a legacy object, a URL, or a string', () => {
    const parts = { protocol: 'https:', hostname: 'example.com', pathname: '/x', query: { a: '1' } }
    expect(format(parts)).toBe(nodeUrl.format(parts))
    expect(format(new URL('https://example.com/y?b=2'))).toBe('https://example.com/y?b=2')
    expect(url.format('https://example.com/z')).toBe('https://example.com/z')
  })
})

describe('querystring', () => {
  it.each(['a=1&b=2&a=3', 'x=%20y+z&empty=&flag', 'k=%E2%82%AC', ''])('parse(%s) matches Node', (input) => {
    expect({ ...querystring.parse(input) }).toEqual({ ...nodeQuerystring.parse(input) })
  })

  it('stringify matches Node, arrays and escaping included', () => {
    const value = { a: ['1', '2'], b: 'x y', c: '€', d: 3, e: true }
    expect(querystring.stringify(value)).toBe(nodeQuerystring.stringify(value))
    expect(querystring.stringify({ a: '1', b: '2' }, ';', ':')).toBe(nodeQuerystring.stringify({ a: '1', b: '2' }, ';', ':'))
  })

  it('escape/unescape and the decode/encode aliases match Node', () => {
    expect(querystring.escape('a b&c')).toBe(nodeQuerystring.escape('a b&c'))
    expect(querystring.unescape('a%20b')).toBe('a b')
    expect(querystring.decode).toBe(querystring.parse)
    expect(querystring.encode).toBe(querystring.stringify)
  })
})

describe('string_decoder', () => {
  it.each([
    ['utf8', [[0xe2], [0x82, 0xac, 0x41]]],
    ['utf16le', [[0x41], [0x00, 0x42], [0x00]]],
    ['base64', [[0x68, 0x65], [0x6c, 0x6c, 0x6f]]],
    ['hex', [[0xde], [0xad]]],
    ['latin1', [[0xe9], [0x41]]]
  ])('%s decodes split chunks exactly as Node does', (encoding, chunks) => {
    const ours = new StringDecoder(encoding)
    const node = new NodeStringDecoder(encoding as BufferEncoding)
    const oursOut = chunks.map((chunk) => ours.write(new Uint8Array(chunk))).join('') + ours.end()
    const nodeOut = chunks.map((chunk) => node.write(Buffer.from(chunk))).join('') + node.end()
    expect(oursOut).toBe(nodeOut)
  })

  it('end() flushes an incomplete character as Node does', () => {
    const ours = new StringDecoder('utf8')
    const node = new NodeStringDecoder('utf8')
    expect(ours.write(new Uint8Array([0xe2, 0x82])) + ours.end()).toBe(node.write(Buffer.from([0xe2, 0x82])) + node.end())
  })

  it('can be inherited from the legacy way, `StringDecoder.call(this, encoding)`, as iconv-lite does', () => {
    function Decoder (this: object, encoding: string): void { (StringDecoder as unknown as (this: object, encoding: string) => void).call(this, encoding) }
    Object.setPrototypeOf(Decoder.prototype, StringDecoder.prototype)
    const derived = new (Decoder as unknown as new (encoding: string) => InstanceType<typeof StringDecoder>)('utf8')
    expect(derived).toBeInstanceOf(StringDecoder)
    expect(derived.encoding).toBe('utf8')
    expect(derived.write(new Uint8Array([0xe2, 0x82])) + derived.write(new Uint8Array([0xac]))).toBe('\u20ac')
    expect(() => StringDecoder.prototype.write.call({}, 'x')).toThrowError(expect.objectContaining({ code: 'ERR_INVALID_THIS' }) as Error)
  })
})
