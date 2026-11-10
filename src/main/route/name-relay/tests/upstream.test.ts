// The connection to an address through the proxy the system named (or, for a first DIRECT, straight to it), against real
// loopback upstreams.

import { connect as netConnect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { startSocks5Fixture } from '../../../../broker/route/tests/socks5-fixture.test-helpers.js'
import { createRunCertificate } from '../../../../protocols/verifier-host/serve/certificate.js'
import type { ProxyEntry } from '../proxy-answer.js'
import { connectDirect, connectThroughProxy, UpstreamFailure } from '../upstream.js'
import type { UpstreamEffect } from '../upstream.js'
import { closeAll, closedPort, closeLater, keep, readBytes, startConnectProxy, startEcho, startSocks4Proxy } from './upstream-fixtures.test-helpers.js'

afterEach(closeAll)

const signal = (): AbortSignal => new AbortController().signal
const ADDRESS = '203.0.113.7'

async function failure (attempt: Promise<unknown>): Promise<UpstreamFailure> {
  const error = await attempt.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(UpstreamFailure)
  return error as UpstreamFailure
}

function expectFailure (error: UpstreamFailure, effect: UpstreamEffect, word: UpstreamFailure['word']): void {
  expect({ effect: error.effect, word: error.word }).toEqual({ effect, word })
}

async function through (proxy: ProxyEntry, address = ADDRESS, port = 443, options: Parameters<typeof connectThroughProxy>[4] = {}): ReturnType<typeof connectThroughProxy> {
  return keep(await connectThroughProxy(proxy, address, port, signal(), options))
}

async function echoes (socket: Awaited<ReturnType<typeof through>>, text = 'hello'): Promise<void> {
  socket.write(text)
  expect(await readBytes(socket, text.length)).toBe(text)
}

describe('the CONNECT proxy these tests use', () => {
  it('notices a request that names a site, so that the tests below prove the relay sends none', async () => {
    const proxy = await startConnectProxy({ targets: {} })
    const socket = keep(netConnect({ host: '127.0.0.1', port: proxy.port }))
    socket.write('CONNECT shop.example:443 HTTP/1.1\r\nHost: shop.example:443\r\n\r\n')
    expect(await readBytes(socket, 12)).toContain('502')
    expect(proxy.namesSeen).toEqual(['CONNECT shop.example:443 HTTP/1.1'])
    proxy.namesSeen.length = 0
    const mismatched = keep(netConnect({ host: '127.0.0.1', port: proxy.port }))
    mismatched.write(`CONNECT ${ADDRESS}:443 HTTP/1.1\r\nHost: shop.example\r\n\r\n`)
    await readBytes(mismatched, 12)
    expect(proxy.namesSeen).toHaveLength(1)
    proxy.namesSeen.length = 0
  })
})

describe('through an HTTP proxy', () => {
  it('asks for a tunnel to the address, and says no name anywhere in the request', async () => {
    const echo = await startEcho()
    const proxy = await startConnectProxy({ targets: { [`${ADDRESS}:443`]: echo.port } })
    const socket = await through({ kind: 'http', host: '127.0.0.1', port: proxy.port })
    expect(proxy.seen).toHaveLength(1)
    expect(proxy.seen[0]?.requestLine).toBe(`CONNECT ${ADDRESS}:443 HTTP/1.1`)
    expect(proxy.seen[0]?.headers.host).toBe(`${ADDRESS}:443`)
    expect(Object.keys(proxy.seen[0]?.headers ?? {})).toEqual(['host'])
    await echoes(socket)
  })

  it('writes an IPv6 address in brackets', async () => {
    const proxy = await startConnectProxy({ targets: {} })
    await failure(connectThroughProxy({ kind: 'http', host: '127.0.0.1', port: proxy.port }, '2001:db8::1', 8443, signal()))
    expect(proxy.seen[0]?.requestLine).toBe('CONNECT [2001:db8::1]:8443 HTTP/1.1')
    expect(proxy.seen[0]?.headers.host).toBe('[2001:db8::1]:8443')
  })

  it('hands back the stream paused, with what the target said first still in it', async () => {
    const echo = await startEcho()
    const proxy = await startConnectProxy({ targets: { [`${ADDRESS}:80`]: echo.port }, firstBytes: 'SSH-2.0-first\r\n' })
    const socket = await through({ kind: 'http', host: '127.0.0.1', port: proxy.port }, ADDRESS, 80)
    expect(socket.isPaused()).toBe(true)
    expect(await readBytes(socket, 15)).toBe('SSH-2.0-first\r\n')
  })

  it('goes on to the next address when the proxy says that one could not be reached', async () => {
    for (const status of [502, 503, 504]) {
      const proxy = await startConnectProxy({ status })
      expectFailure(await failure(connectThroughProxy({ kind: 'http', host: '127.0.0.1', port: proxy.port }, ADDRESS, 443, signal())), 'address', 'unreachable')
    }
  })

  it('ends the attempt on a refusal or a request for a sign-in', async () => {
    const forbidden = await startConnectProxy({ status: 403 })
    expectFailure(await failure(connectThroughProxy({ kind: 'http', host: '127.0.0.1', port: forbidden.port }, ADDRESS, 443, signal())), 'final', 'refused')
    const signIn = await startConnectProxy({ status: 407 })
    expectFailure(await failure(connectThroughProxy({ kind: 'http', host: '127.0.0.1', port: signIn.port }, ADDRESS, 443, signal())), 'final', 'sign-in')
    const odd = await startConnectProxy({ status: 500 })
    expectFailure(await failure(connectThroughProxy({ kind: 'http', host: '127.0.0.1', port: odd.port }, ADDRESS, 443, signal())), 'final', 'refused')
  })

  it('takes any 2xx as a tunnel', async () => {
    const echo = await startEcho()
    const proxy = await startConnectProxy({ targets: { [`${ADDRESS}:443`]: echo.port } })
    await echoes(await through({ kind: 'http', host: '127.0.0.1', port: proxy.port }))
  })

  it('moves to the next proxy when this one cannot be reached or does not speak HTTP', async () => {
    const port = await closedPort()
    expectFailure(await failure(connectThroughProxy({ kind: 'http', host: '127.0.0.1', port }, ADDRESS, 443, signal())), 'proxy', 'unreachable')
    const garbage = await startConnectProxy({ garbage: true })
    expectFailure(await failure(connectThroughProxy({ kind: 'http', host: '127.0.0.1', port: garbage.port }, ADDRESS, 443, signal())), 'proxy', 'unreachable')
    const hangUp = await startConnectProxy({ hangUp: true })
    expectFailure(await failure(connectThroughProxy({ kind: 'http', host: '127.0.0.1', port: hangUp.port }, ADDRESS, 443, signal())), 'proxy', 'unreachable')
  })

  it('gives up on a proxy that never answers, as an address that could not be reached', async () => {
    const proxy = await startConnectProxy({ silent: true })
    expectFailure(await failure(connectThroughProxy({ kind: 'http', host: '127.0.0.1', port: proxy.port }, ADDRESS, 443, signal(), { timeoutMs: 60 })), 'address', 'unreachable')
  })

  it('stops, and closes the connection, when the client gives up', async () => {
    const proxy = await startConnectProxy({ silent: true })
    const controller = new AbortController()
    const attempt = connectThroughProxy({ kind: 'http', host: '127.0.0.1', port: proxy.port }, ADDRESS, 443, controller.signal)
    const outcome = attempt.then(() => 'connected', (error: Error) => error.name)
    setTimeout(() => { controller.abort() }, 30)
    expect(await outcome).toBe('AbortError')
    expect(await connectThroughProxy({ kind: 'http', host: '127.0.0.1', port: proxy.port }, ADDRESS, 443, controller.signal).then(() => 'connected', (error: Error) => error.name)).toBe('AbortError')
  })
})

describe('through an HTTPS proxy', () => {
  const certificate = createRunCertificate(new Date(), 30, 'localhost')

  it('speaks the same CONNECT over a connection verified against the roots it is given', async () => {
    const echo = await startEcho()
    const proxy = await startConnectProxy({ targets: { [`${ADDRESS}:443`]: echo.port }, tls: { key: certificate.keyPem, cert: certificate.certPem } })
    const socket = await through({ kind: 'https', host: 'localhost', port: proxy.port }, ADDRESS, 443, { roots: [certificate.certPem] })
    expect(proxy.seen[0]?.requestLine).toBe(`CONNECT ${ADDRESS}:443 HTTP/1.1`)
    await echoes(socket)
  })

  it('does not trust a certificate the roots do not vouch for', async () => {
    const proxy = await startConnectProxy({ targets: {}, tls: { key: certificate.keyPem, cert: certificate.certPem } })
    const other = createRunCertificate(new Date(), 30, 'localhost')
    expectFailure(await failure(connectThroughProxy({ kind: 'https', host: 'localhost', port: proxy.port }, ADDRESS, 443, signal(), { roots: [other.certPem] })), 'proxy', 'unreachable')
    expect(proxy.seen).toHaveLength(0)
  })

  it('does not trust a certificate made for another name', async () => {
    const proxy = await startConnectProxy({ targets: {}, tls: { key: certificate.keyPem, cert: certificate.certPem } })
    expectFailure(await failure(connectThroughProxy({ kind: 'https', host: '127.0.0.1', port: proxy.port }, ADDRESS, 443, signal(), { roots: [certificate.certPem] })), 'proxy', 'unreachable')
    expect(proxy.seen).toHaveLength(0)
  })
})

describe('through a SOCKS5 proxy', () => {
  it('asks for the address by its type and offers no sign-in', async () => {
    const echo = await startEcho()
    const proxy = await startSocks5Fixture({ names: { [`${ADDRESS}:443`]: { host: '127.0.0.1', port: echo.port } }, refuseUnmapped: true })
    closeLater(proxy.close)
    const socket = await through({ kind: 'socks5', host: '127.0.0.1', port: proxy.port })
    expect(proxy.requests).toHaveLength(1)
    expect(proxy.requests[0]).toMatchObject({ command: 'connect', destination: ADDRESS, port: 443, addressType: 'ipv4', methods: [0] })
    await echoes(socket)
  })

  it('asks for an IPv6 address as one', async () => {
    const proxy = await startSocks5Fixture({ refuseUnmapped: true })
    closeLater(proxy.close)
    expectFailure(await failure(connectThroughProxy({ kind: 'socks5', host: '127.0.0.1', port: proxy.port }, '2001:db8::1', 443, signal())), 'address', 'unreachable')
    expect(proxy.requests[0]?.addressType).toBe('ipv6')
  })

  it('goes on to the next address when the proxy says unreachable, and not on any other refusal', async () => {
    const unreachable = await startSocks5Fixture({ refuseUnmapped: true })
    closeLater(unreachable.close)
    expectFailure(await failure(connectThroughProxy({ kind: 'socks5', host: '127.0.0.1', port: unreachable.port }, ADDRESS, 443, signal())), 'address', 'unreachable')
    const authRequired = await startSocks5Fixture({ requireAuth: true })
    closeLater(authRequired.close)
    expectFailure(await failure(connectThroughProxy({ kind: 'socks5', host: '127.0.0.1', port: authRequired.port }, ADDRESS, 443, signal())), 'final', 'sign-in')
  })

  it('moves to the next proxy when this one cannot be reached', async () => {
    const port = await closedPort()
    expectFailure(await failure(connectThroughProxy({ kind: 'socks5', host: '127.0.0.1', port }, ADDRESS, 443, signal())), 'proxy', 'unreachable')
  })
})

describe('through a SOCKS4 proxy', () => {
  it('asks for the IPv4 address', async () => {
    const echo = await startEcho()
    const proxy = await startSocks4Proxy({ targets: { [`${ADDRESS}:443`]: echo.port } })
    const socket = await through({ kind: 'socks4', host: '127.0.0.1', port: proxy.port })
    expect(proxy.seen).toEqual([{ command: 1, address: ADDRESS, port: 443, userId: '' }])
    expect(socket.isPaused()).toBe(true)
    await echoes(socket)
  })

  it('cannot carry an IPv6 address, and does not ask', async () => {
    const proxy = await startSocks4Proxy()
    expectFailure(await failure(connectThroughProxy({ kind: 'socks4', host: '127.0.0.1', port: proxy.port }, '2001:db8::1', 443, signal())), 'address', 'unreachable')
    expect(proxy.seen).toHaveLength(0)
  })

  it('goes on to the next address when the request fails, and ends on a refused user id', async () => {
    const failed = await startSocks4Proxy({ reply: 91 })
    expectFailure(await failure(connectThroughProxy({ kind: 'socks4', host: '127.0.0.1', port: failed.port }, ADDRESS, 443, signal())), 'address', 'unreachable')
    const refused = await startSocks4Proxy({ reply: 93 })
    expectFailure(await failure(connectThroughProxy({ kind: 'socks4', host: '127.0.0.1', port: refused.port }, ADDRESS, 443, signal())), 'final', 'sign-in')
  })
})

describe('with no proxy', () => {
  it('connects to the address and hands the stream back paused', async () => {
    const echo = await startEcho()
    const socket = keep(await connectDirect('127.0.0.1', echo.port, signal()))
    expect(socket.isPaused()).toBe(true)
    await echoes(socket)
  })

  it('goes on to the next address when this one is refused', async () => {
    const port = await closedPort()
    expectFailure(await failure(connectDirect('127.0.0.1', port, signal())), 'address', 'unreachable')
  })
})
