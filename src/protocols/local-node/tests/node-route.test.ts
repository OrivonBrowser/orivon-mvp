// A node that runs through a tunnel: every dial, datagram and name lookup reaches a SOCKS5 fixture and nothing else, and a
// route that is gone ends them all instead of falling back to this computer.

import { createSocket } from 'node:dgram'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createTcpServer } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'
import { createServer as createTlsServer } from 'node:tls'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSocks5Provider } from '../../../broker/route/socks5.js'
import type { RouteProvider } from '../../../broker/route/provider.js'
import { startSocks5Fixture } from '../../../broker/route/tests/socks5-fixture.test-helpers.js'
import type { Socks5Fixture, Socks5FixtureOptions } from '../../../broker/route/tests/socks5-fixture.test-helpers.js'
import { MAX_ADDRESSES, MAX_PENDING_DIALS, createRoutedNetDeps, routedDial, routedFetch } from '../node-route.js'
import { REAL, createNodeNet } from '../node-net.js'
import type { RouteSource } from '../node-route.js'

/** A certificate for one host name, which `tls` is told to trust for the test (the fixture needs `openssl`, as the end-to-end suite does). */
function selfSigned (dir: string, name: string): { cert: string, key: string } {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${name}`, '-addext', `subjectAltName=DNS:${name}`, '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1'], { stdio: 'pipe' })
  return { cert: readFileSync(join(dir, 'cert.pem'), 'utf8'), key: readFileSync(join(dir, 'key.pem'), 'utf8') }
}

const HAS_OPENSSL = (() => { try { execFileSync('openssl', ['version'], { stdio: 'pipe' }); return true } catch { return false } })()
const API_PORT = 24_243
const ENDPOINTS = ['https://doh.test/dns-query']
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function fixture (options: Socks5FixtureOptions = {}): Promise<Socks5Fixture> {
  const started = await startSocks5Fixture(options)
  cleanups.push(started.close)
  return started
}

function sourceOf (proxy: Socks5Fixture): RouteSource {
  const provider = createSocks5Provider({ host: proxy.host, port: proxy.port, credentials: { userId: 'orivon-node-test', password: 'secret' } })
  return async () => provider
}

async function echoServer (): Promise<number> {
  const open = new Set<Socket>()
  const server: Server = createTcpServer((socket) => {
    open.add(socket)
    socket.on('close', () => open.delete(socket))
    socket.on('error', () => {})
    socket.on('data', (chunk) => socket.write(chunk))
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  cleanups.push(async () => {
    for (const socket of open) socket.destroy()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })
  return (server.address() as AddressInfo).port
}

async function udpEcho (): Promise<number> {
  const socket = createSocket('udp4')
  socket.on('message', (data, from) => { socket.send(data, from.port, from.address) })
  await new Promise<void>((resolve) => { socket.bind(0, '127.0.0.1', resolve) })
  cleanups.push(() => { socket.close() })
  return socket.address().port
}

async function readOne (stream: ReadableStream<Uint8Array>): Promise<string> {
  const { value } = await stream.getReader().read()
  return new TextDecoder().decode(value)
}

describe('a node routed through a tunnel', () => {
  it('opens a stream to a public address through the tunnel, as an address, with the node\'s own sign-in', async () => {
    const target = await echoServer()
    const proxy = await fixture({ preferAuth: true, names: { '8.8.8.8:4001': { host: '127.0.0.1', port: target } } })
    const net = createNodeNet(API_PORT, createRoutedNetDeps(sourceOf(proxy), ENDPOINTS))

    const socket = await net.connect({ host: '8.8.8.8', port: 4001 })
    const writer = socket.writable.getWriter()
    await writer.write(new TextEncoder().encode('ping'))

    expect(await readOne(socket.readable)).toBe('ping')
    expect(proxy.requests).toMatchObject([{ command: 'connect', destination: '8.8.8.8', port: 4001, addressType: 'ipv4', userId: 'orivon-node-test', password: 'secret' }])
    await socket.close()
  })

  it('still refuses an address that is not public, and the tunnel is not asked', async () => {
    const proxy = await fixture()
    const net = createNodeNet(API_PORT, createRoutedNetDeps(sourceOf(proxy), ENDPOINTS))
    for (const host of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', '::1']) await expect(net.connect({ host, port: 4001 })).rejects.toMatchObject({ code: 'denied' })
    expect(proxy.requests).toEqual([])
  })

  it('tries the next address when the first cannot be reached, IPv4 first', async () => {
    const target = await echoServer()
    const closed = createTcpServer()
    await new Promise<void>((resolve) => { closed.listen(0, '127.0.0.1', resolve) })
    const closedPort = (closed.address() as AddressInfo).port
    await new Promise<void>((resolve) => { closed.close(() => { resolve() }) })
    const proxy = await fixture({ names: { '1.2.3.4:4001': { host: '127.0.0.1', port: closedPort }, '9.9.9.9:4001': { host: '127.0.0.1', port: target } } })
    const dial = routedDial(sourceOf(proxy))
    const socket = await dial(['2606:4700:4700::1111', '1.2.3.4', '9.9.9.9'], 4001, new AbortController().signal)
    expect(proxy.requests.map((request) => request.destination)).toEqual(['1.2.3.4', '9.9.9.9'])
    await socket.destroy('closed')
  })

  it('carries datagrams to a public resolver through the tunnel, and reads the answer, with no socket of this computer bound', async () => {
    const echo = await udpEcho()
    const proxy = await fixture({ names: { '1.1.1.1:53': { host: '127.0.0.1', port: echo } } })
    const net = createNodeNet(API_PORT, createRoutedNetDeps(sourceOf(proxy), ENDPOINTS))

    const udp = await net.udpBind({ port: 0 })
    const writer = udp.writable.getWriter()
    await writer.write({ data: new TextEncoder().encode('who'), address: '1.1.1.1', port: 53, family: 'IPv4' })
    const { value } = await udp.readable.getReader().read()

    expect(new TextDecoder().decode(value?.data)).toBe('who')
    expect(value).toMatchObject({ address: '1.1.1.1', port: 53 })
    expect(proxy.datagrams).toEqual(['1.1.1.1:53'])
    await udp.close()
  })

  it('refuses a datagram to a port other than 53, so the tunnel never carries it', async () => {
    const proxy = await fixture()
    const net = createNodeNet(API_PORT, createRoutedNetDeps(sourceOf(proxy), ENDPOINTS))
    const udp = await net.udpBind({ port: 0 })
    await udp.writable.getWriter().write({ data: new Uint8Array(1), address: '1.1.1.1', port: 4001, family: 'IPv4' })
    expect(proxy.datagrams).toEqual([])
    expect(udp.droppedOutbound).toBe(1)
    await udp.close()
  })

  it('has no datagrams at all through a tunnel that carries none (Tor), and binds no socket of its own instead', async () => {
    const proxy = await fixture({ noUdp: true })
    const net = createNodeNet(API_PORT, createRoutedNetDeps(sourceOf(proxy), ENDPOINTS))
    await expect(net.udpBind({ port: 0 })).rejects.toBeDefined()
  })

  it('shares no adapter with the direct node: dial, bind and name lookup are the tunnel\'s own', () => {
    const deps = createRoutedNetDeps(async () => await Promise.reject(new Error('no route')), ENDPOINTS)
    expect(deps.dial).not.toBe(REAL.dial)
    expect(deps.bind).not.toBe(REAL.bind)
    expect(deps.lookup).not.toBe(REAL.lookup)
  })

  it('fails closed when the route is gone: no dial, no datagram socket, no lookup', async () => {
    const net = createNodeNet(API_PORT, createRoutedNetDeps(async () => await Promise.reject(new Error('Nym is switched off')), ENDPOINTS))
    await expect(net.connect({ host: '8.8.8.8', port: 4001 })).rejects.toMatchObject({ code: 'unreachable' })
    await expect(net.connect({ host: 'peer.test', port: 4001 })).rejects.toMatchObject({ code: 'unreachable' })
    await expect(net.udpBind({ port: 0 })).rejects.toMatchObject({ code: 'unreachable' })
    await expect(net.lookup({ hostname: 'peer.test' })).rejects.toMatchObject({ code: 'unreachable' })
  })

  it('keeps its API listener on loopback, on the API port', async () => {
    const proxy = await fixture()
    const net = createNodeNet(API_PORT, createRoutedNetDeps(sourceOf(proxy), ENDPOINTS))
    await expect(net.listen({ port: 80, scope: 'network' })).rejects.toMatchObject({ code: 'denied' })
    const server = await net.listen({ port: 0 })
    expect(server.localAddress).toBe('127.0.0.1')
    await server.close()
    expect(proxy.requests).toEqual([])
  })

  it('opens no more than the allowed number of streams at once, and the rest wait', async () => {
    let open = 0
    let most = 0
    const provider: RouteProvider = {
      connect: async () => {
        open += 1
        most = Math.max(most, open)
        await new Promise((resolve) => setTimeout(resolve, 5))
        open -= 1
        throw new Error('stop here')
      }
    }
    const dial = routedDial(async () => provider)
    await Promise.allSettled(Array.from({ length: MAX_PENDING_DIALS * 2 }, async () => await dial(['1.2.3.4'], 1, new AbortController().signal)))
    expect(most).toBe(MAX_PENDING_DIALS)
  })

  it('tries only a few of a name\'s addresses, so a name with dozens of dead ones does not hold a slot', async () => {
    const tried: string[] = []
    const provider: RouteProvider = { connect: async (host) => { tried.push(host); throw new Error('dead') } }
    const dial = routedDial(async () => provider)
    await expect(dial(Array.from({ length: 20 }, (_, i) => `1.2.3.${String(i + 1)}`), 1, new AbortController().signal)).rejects.toBeDefined()
    expect(tried).toHaveLength(MAX_ADDRESSES)
  })

  it('lets a waiting dial go when its caller gives up', async () => {
    const provider: RouteProvider = { connect: async () => await new Promise(() => {}) }
    const dial = routedDial(async () => provider)
    for (let i = 0; i < MAX_PENDING_DIALS; i += 1) void dial(['1.2.3.4'], 1, new AbortController().signal).catch(() => {})
    const gives = new AbortController()
    const waiting = dial(['1.2.3.4'], 1, gives.signal)
    gives.abort()
    await expect(waiting).rejects.toMatchObject({ code: 'revoked' })
  })
})

describe('a name looked up through the tunnel', () => {
  it('gives up on a tunnel that stalls in the middle of the TLS handshake, instead of waiting for ever', async () => {
    const silent = await echoServer()
    const proxy = await fixture({ names: { 'doh.test:443': { host: '127.0.0.1', port: silent } } })
    // The server it reaches accepts and echoes bytes that are not a TLS answer; either way the fetch must end.
    const fetchOver = routedFetch(sourceOf(proxy), {}, 150)
    await expect(fetchOver('https://doh.test/dns-query')).rejects.toBeDefined()
  })

  it.skipIf(!HAS_OPENSSL)('is asked of a DNS-over-HTTPS endpoint over a TLS connection the tunnel carries, then dialled as the address that came back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orivon-node-route-'))
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
    const pem = selfSigned(dir, 'doh.test')
    const questions: string[] = []
    const doh = createTlsServer({ key: pem.key, cert: pem.cert }, (socket) => {
      let request = ''
      socket.on('data', (chunk) => {
        request += chunk.toString()
        if (!request.includes('\r\n\r\n')) return
        const line = request.split('\r\n')[0] ?? ''
        questions.push(line)
        const type = /type=(\w+)/.exec(line)?.[1]
        const body = JSON.stringify({ Status: 0, Answer: type === 'A' ? [{ name: 'peer.test', type: 1, TTL: 60, data: '93.184.216.34' }] : [] })
        socket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/dns-json\r\nContent-Length: ${String(Buffer.byteLength(body))}\r\nConnection: keep-alive\r\n\r\n${body}`)
        request = ''
      })
      socket.on('error', () => {})
    })
    await new Promise<void>((resolve) => { doh.listen(0, '127.0.0.1', resolve) })
    cleanups.push(async () => { await new Promise<void>((resolve) => { doh.close(() => { resolve() }) }) })
    const target = await echoServer()
    const proxy = await fixture({ names: { 'doh.test:443': { host: '127.0.0.1', port: (doh.address() as AddressInfo).port }, '93.184.216.34:4001': { host: '127.0.0.1', port: target } } })
    const net = createNodeNet(API_PORT, createRoutedNetDeps(sourceOf(proxy), ['https://doh.test/dns-query'], { ca: pem.cert }))

    const socket = await net.connect({ host: 'peer.test', port: 4001 })

    expect(questions.some((line) => line.includes('name=peer.test') && line.includes('type=A'))).toBe(true)
    expect(proxy.requests.map((request) => `${request.destination}:${String(request.port)}`)).toEqual(expect.arrayContaining(['doh.test:443', '93.184.216.34:4001']))
    expect(proxy.requests.some((request) => request.destination === 'peer.test')).toBe(false)
    await socket.close()
  })

  it('is refused, never asked of the system resolver, when no DNS-over-HTTPS endpoint answers', async () => {
    const proxy = await fixture()
    const net = createNodeNet(API_PORT, createRoutedNetDeps(sourceOf(proxy), ENDPOINTS))
    await expect(net.lookup({ hostname: 'example.com' })).rejects.toMatchObject({ code: 'unreachable' })
  })
})
