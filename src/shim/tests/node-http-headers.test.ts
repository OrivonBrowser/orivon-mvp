import { describe, expect, it } from 'vitest'
import { HeaderBag, serializeRequestHead, defaultHostHeader } from '../node-http-headers.js'

describe('HeaderBag', () => {
  it('is case-insensitive for get/has/remove but preserves the set case for output', () => {
    const bag = new HeaderBag()
    bag.set('Content-Type', 'text/plain')
    expect(bag.has('content-type')).toBe(true)
    expect(bag.get('CONTENT-TYPE')).toBe('text/plain')
    bag.remove('content-type')
    expect(bag.has('Content-Type')).toBe(false)
  })

  it('overwrites a prior value set under a different case', () => {
    const bag = new HeaderBag()
    bag.set('X-Foo', 'one')
    bag.set('x-foo', 'two')
    expect(bag.entries()).toHaveLength(1)
    expect(bag.get('X-Foo')).toBe('two')
  })

  it('setAll applies every entry of a plain object', () => {
    const bag = new HeaderBag()
    bag.setAll({ 'X-A': '1', 'X-B': '2' })
    expect(bag.get('x-a')).toBe('1')
    expect(bag.get('x-b')).toBe('2')
  })

  it('setAll is a no-op for undefined', () => {
    const bag = new HeaderBag()
    bag.setAll(undefined)
    expect(bag.entries()).toHaveLength(0)
  })

  it('rejects a header value carrying a raw CRLF, matching Node -- this is header-injection prevention, not a style rule', () => {
    const bag = new HeaderBag()
    expect(() => bag.set('X-Evil', 'value\r\nX-Injected: yes')).toThrow(/invalid header value/)
  })

  it('rejects a header name carrying a raw CR or LF', () => {
    const bag = new HeaderBag()
    expect(() => bag.set('X-Evil\r\nX-Injected', 'value')).toThrow(/invalid header name/)
  })

  it('rejects an array-valued header if any element carries a raw CRLF', () => {
    const bag = new HeaderBag()
    expect(() => bag.set('X-Multi', ['fine', 'bad\r\nX-Injected: yes'])).toThrow(/invalid header value/)
  })
})

describe('serializeRequestHead', () => {
  it('writes a request line, one header line per entry, and a terminating blank line', () => {
    const bag = new HeaderBag()
    bag.set('Host', 'example.com')
    bag.set('Accept', '*/*')
    const bytes = serializeRequestHead('GET', '/path?q=1', bag)
    const text = new TextDecoder().decode(bytes)
    expect(text).toBe('GET /path?q=1 HTTP/1.1\r\nHost: example.com\r\nAccept: */*\r\n\r\n')
  })

  it('writes one line per element of an array-valued header', () => {
    const bag = new HeaderBag()
    bag.set('X-Multi', ['a', 'b'])
    const text = new TextDecoder().decode(serializeRequestHead('GET', '/', bag))
    expect(text).toBe('GET / HTTP/1.1\r\nX-Multi: a\r\nX-Multi: b\r\n\r\n')
  })
})

describe('serializeRequestHead -- injection guards', () => {
  it('rejects a path carrying a raw CRLF', () => {
    const bag = new HeaderBag()
    expect(() => serializeRequestHead('GET', '/foo\r\nX-Injected: yes', bag)).toThrow(/invalid request line/)
  })

  it('rejects a method carrying a raw CRLF', () => {
    const bag = new HeaderBag()
    expect(() => serializeRequestHead('GET\r\nX-Injected: yes', '/', bag)).toThrow(/invalid request line/)
  })
})

describe('defaultHostHeader', () => {
  it('omits the port when it matches the scheme default', () => {
    expect(defaultHostHeader('example.com', 443, 443)).toBe('example.com')
  })

  it('includes the port when it differs from the scheme default', () => {
    expect(defaultHostHeader('example.com', 8443, 443)).toBe('example.com:8443')
  })
})
