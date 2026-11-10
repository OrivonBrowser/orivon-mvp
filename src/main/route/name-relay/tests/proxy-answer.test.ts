// What T20's answer for a URL comes to: the proxies the relay may use in order, a first `DIRECT`, or a reason to refuse.

import { describe, expect, it } from 'vitest'
import { onAnonymityPort, parseProxyAnswer } from '../proxy-answer.js'

const http = (host: string, port: number): object => ({ scheme: 'http', host, port })

describe('one entry', () => {
  it('reads each scheme Chromium writes', () => {
    expect(parseProxyAnswer('PROXY proxy.corp.example:8080')).toEqual({ kind: 'proxies', entries: [http('proxy.corp.example', 8080)] })
    expect(parseProxyAnswer('HTTPS secure.example:443')).toEqual({ kind: 'proxies', entries: [{ scheme: 'https', host: 'secure.example', port: 443 }] })
    expect(parseProxyAnswer('SOCKS5 127.0.0.1:1080')).toEqual({ kind: 'proxies', entries: [{ scheme: 'socks5', host: '127.0.0.1', port: 1080 }] })
    expect(parseProxyAnswer('SOCKS 10.0.0.2:1081')).toEqual({ kind: 'proxies', entries: [{ scheme: 'socks4', host: '10.0.0.2', port: 1081 }] })
    expect(parseProxyAnswer('SOCKS4 10.0.0.2:1081')).toEqual({ kind: 'proxies', entries: [{ scheme: 'socks4', host: '10.0.0.2', port: 1081 }] })
  })

  it('reads a keyword in any case, extra spaces and an HTTP entry', () => {
    expect(parseProxyAnswer('  proxy   a.example:3128 ')).toEqual({ kind: 'proxies', entries: [http('a.example', 3128)] })
    expect(parseProxyAnswer('HTTP a.example:3128')).toEqual({ kind: 'proxies', entries: [http('a.example', 3128)] })
  })

  it('takes the scheme\'s usual port when the entry has none', () => {
    expect(parseProxyAnswer('PROXY a.example')).toEqual({ kind: 'proxies', entries: [http('a.example', 80)] })
    expect(parseProxyAnswer('HTTPS a.example')).toEqual({ kind: 'proxies', entries: [{ scheme: 'https', host: 'a.example', port: 443 }] })
    expect(parseProxyAnswer('SOCKS5 a.example')).toEqual({ kind: 'proxies', entries: [{ scheme: 'socks5', host: 'a.example', port: 1080 }] })
  })

  it('reads an IPv6 proxy with its brackets taken off', () => {
    expect(parseProxyAnswer('PROXY [2001:db8::1]:8080')).toEqual({ kind: 'proxies', entries: [http('2001:db8::1', 8080)] })
    expect(parseProxyAnswer('SOCKS5 [::1]')).toEqual({ kind: 'proxies', entries: [{ scheme: 'socks5', host: '::1', port: 1080 }] })
  })

  it('reads DIRECT as the system sending the connection outside any proxy', () => {
    expect(parseProxyAnswer('DIRECT')).toEqual({ kind: 'direct' })
    expect(parseProxyAnswer(' direct ')).toEqual({ kind: 'direct' })
  })
})

describe('a list', () => {
  it('keeps the proxies in the order the system wrote them', () => {
    expect(parseProxyAnswer('PROXY a.example:1; SOCKS5 b.example:2; HTTPS c.example:3')).toEqual({
      kind: 'proxies',
      entries: [http('a.example', 1), { scheme: 'socks5', host: 'b.example', port: 2 }, { scheme: 'https', host: 'c.example', port: 3 }]
    })
  })

  it('never takes a DIRECT that follows a proxy, nor anything after it', () => {
    expect(parseProxyAnswer('PROXY a.example:1; DIRECT')).toEqual({ kind: 'proxies', entries: [http('a.example', 1)] })
    expect(parseProxyAnswer('PROXY a.example:1; DIRECT; PROXY b.example:2')).toEqual({ kind: 'proxies', entries: [http('a.example', 1)] })
  })

  it('takes a DIRECT that comes first, whatever follows it', () => {
    expect(parseProxyAnswer('DIRECT; PROXY a.example:1')).toEqual({ kind: 'direct' })
  })

  it('leaves out an entry of a kind the relay cannot speak, and refuses when nothing else is left', () => {
    expect(parseProxyAnswer('QUIC q.example:443; PROXY a.example:1')).toEqual({ kind: 'proxies', entries: [http('a.example', 1)] })
    expect(parseProxyAnswer('QUIC q.example:443')).toEqual({ kind: 'refused' })
    expect(parseProxyAnswer('QUIC q.example:443; DIRECT')).toEqual({ kind: 'refused' })
  })

  it('ignores an empty entry', () => {
    expect(parseProxyAnswer('PROXY a.example:1;')).toEqual({ kind: 'proxies', entries: [http('a.example', 1)] })
  })
})

describe('an answer that is not one', () => {
  it.each([
    '',
    '   ',
    ';',
    'PROXY',
    'PROXY :8080',
    'PROXY a.example:0',
    'PROXY a.example:65536',
    'PROXY a.example:80x',
    'PROXY a.example:-1',
    'PROXY a b:80',
    'PROXY http://a.example:80',
    'PROXY user@a.example:80',
    'PROXY [not-an-address]:80',
    'PROXY [2001:db8::1:80',
    'PROXY 2001:db8::1:80',
    'FTP a.example:21',
    'DIRECT a.example:80',
    'garbage',
    'PROXY a.example:1; garbage'
  ])('is junk: %j', (answer) => {
    expect(parseProxyAnswer(answer)).toEqual({ kind: 'junk' })
  })
})

describe('a SOCKS proxy on this computer at a port Tor uses', () => {
  const socks = (scheme: 'socks5' | 'socks4', host: string, port: number): Parameters<typeof onAnonymityPort>[0] => ({ scheme, host, port })

  it('is told by its port on loopback', () => {
    expect(onAnonymityPort(socks('socks5', '127.0.0.1', 9050))).toBe(true)
    expect(onAnonymityPort(socks('socks5', '127.0.0.1', 9150))).toBe(true)
    expect(onAnonymityPort(socks('socks4', 'localhost', 9050))).toBe(true)
    expect(onAnonymityPort(socks('socks5', '::1', 9150))).toBe(true)
    expect(onAnonymityPort(socks('socks5', 'LOCALHOST.', 9050))).toBe(true)
  })

  it('does not stand for another port, another computer or another kind of proxy', () => {
    expect(onAnonymityPort(socks('socks5', '127.0.0.1', 1080))).toBe(false)
    expect(onAnonymityPort(socks('socks5', '10.0.0.5', 9050))).toBe(false)
    expect(onAnonymityPort(socks('socks5', 'tor.example', 9050))).toBe(false)
    expect(onAnonymityPort({ scheme: 'http', host: '127.0.0.1', port: 9050 })).toBe(false)
  })
})
