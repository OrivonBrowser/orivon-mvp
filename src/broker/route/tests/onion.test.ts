import { describe, expect, it } from 'vitest'
import { isOnionHost, isOnionUrl, ONION_NEEDS_TOR } from '../onion.js'

describe('which names are onion addresses (RFC 7686)', () => {
  it('is any name under the onion top-level domain, in any case, with or without the root dot', () => {
    for (const host of ['abc.onion', 'ABC.Onion', 'abc.onion.', 'a.b.c.onion', 'onion', 'onion.', 'abc\u3002onion']) expect(isOnionHost(host), host).toBe(true)
  })

  it('is no other name, address or look-alike', () => {
    for (const host of ['', 'example.com', 'onion.example', 'notonion', 'abc.onions', 'abc.onion.example', 'abc-onion', '127.0.0.1', '[::1]', 'xonion']) expect(isOnionHost(host), host).toBe(false)
  })
})

describe('which addresses name an onion service', () => {
  it('reads the host of any scheme that has one', () => {
    for (const url of ['http://abc.onion/', 'https://abc.onion:8443/a?b#c', 'ws://abc.onion/s', 'wss://ABC.ONION./s', 'http://user:pass@abc.onion/', 'http://abc\uFF0Eonion/']) expect(isOnionUrl(url), url).toBe(true)
  })

  it('leaves alone an address whose host is something else, even one that mentions an onion', () => {
    for (const url of ['https://example.com/abc.onion', 'https://example.com/?u=http://abc.onion/', 'https://abc.onion.example/', 'data:text/html,abc.onion', 'about:blank', 'not a url', '']) expect(isOnionUrl(url), url).toBe(false)
  })
})

describe('the reason an onion address is refused', () => {
  it('names the tunnel that carries it, in the words of Settings', () => {
    expect(ONION_NEEDS_TOR).toMatch(/onion/i)
    expect(ONION_NEEDS_TOR).toContain('Settings')
    expect(ONION_NEEDS_TOR).toContain('SOCKS5')
  })
})
