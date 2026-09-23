// url, querystring and string_decoder, each checked against Node's own
// module on the same input rather than against expectations written here.

import * as nodeQuerystring from 'node:querystring'
import { StringDecoder as NodeStringDecoder } from 'node:string_decoder'
import * as nodeUrl from 'node:url'
import { describe, expect, it } from 'vitest'
import querystring from '../node-querystring.js'
import { StringDecoder } from '../node-string-decoder.js'
import url, { fileURLToPath, format, parse, pathToFileURL, resolve, URL as ShimURL, URLSearchParams as ShimURLSearchParams } from '../node-url.js'

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
    'mailto:someone@example.com'
  ])('legacy parse(%s) matches Node', (input) => {
    const ours = parse(input)
    const node = nodeUrl.parse(input)
    for (const key of ['protocol', 'slashes', 'auth', 'host', 'port', 'hostname', 'hash', 'search', 'query', 'pathname', 'path', 'href'] as const) {
      expect(ours[key], key).toEqual(node[key])
    }
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
})
