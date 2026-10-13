// The SOCKS5 provider against a fixture SOCKS5 server: CONNECT by name,
// UDP ASSOCIATE, which authentication methods the greeting offers, and how
// each failure surfaces. The fixture knows names the machine's resolver does
// not, so a client that resolved a name itself would fail these.

import { createSocket, Socket as DatagramSocket } from 'node:dgram'
import { createServer as createTcpServer } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSocks5Provider, isolationCredentials, routeAnswered } from '../socks5.js'
import type { RoutedDatagram } from '../provider.js'
import { startSocks5Fixture } from './socks5-fixture.test-helpers.js'
import type { Socks5Fixture, Socks5FixtureOptions } from './socks5-fixture.test-helpers.js'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function echoServer (greeting?: string): Promise<number> {
  const open = new Set<Socket>()
  const server: Server = createTcpServer((socket) => {
    open.add(socket)
    socket.on('close', () => open.delete(socket))
    socket.on('error', () => {})
    if (greeting !== undefined) socket.write(greeting)
    socket.on('data', (chunk) => socket.write(chunk))
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  cleanups.push(async () => {
    for (const socket of open) socket.destroy()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })
  return (server.address() as AddressInfo).port
}

async function udpEchoServer (): Promise<number> {
  const socket = createSocket('udp4')
  socket.on('message', (data, from) => { socket.send(data, from.port, from.address) })
  await new Promise<void>((resolve) => { socket.bind(0, '127.0.0.1', resolve) })
  cleanups.push(() => { socket.close() })
  return socket.address().port
}

async function fixture (options: Socks5FixtureOptions = {}): Promise<Socks5Fixture> {
  const started = await startSocks5Fixture(options)
  cleanups.push(started.close)
  return started
}

async function readOne (socket: Socket): Promise<string> {
  // A route's socket arrives paused, as the broker's stream wrapper and a TLS layer expect.
  return await new Promise((resolve) => { socket.once('data', (chunk: Buffer) => { resolve(chunk.toString()) }); socket.resume() })
}

const NEVER = new AbortController().signal

describe('CONNECT', () => {
  it('reaches a target by a name only the proxy knows, sending the name unresolved', async () => {
    const target = await echoServer()
    const proxy = await fixture({ names: { 'only-the-proxy-knows.test:8443': { host: '127.0.0.1', port: target } } })
    const provider = createSocks5Provider({ host: proxy.host, port: proxy.port })

    const socket = await provider.connect('only-the-proxy-knows.test', 8443, NEVER)
    socket.write('ping')

    expect(await readOne(socket)).toBe('ping')
    expect(proxy.requests).toMatchObject([{ command: 'connect', destination: 'only-the-proxy-knows.test', port: 8443, addressType: 'domain' }])
    socket.destroy()
  })

  it('reaches an address literal as an address', async () => {
    const target = await echoServer()
    const proxy = await fixture()
    const provider = createSocks5Provider({ host: proxy.host, port: proxy.port })

    const socket = await provider.connect('127.0.0.1', target, NEVER)
    socket.write('hi')

    expect(await readOne(socket)).toBe('hi')
    expect(proxy.requests[0]).toMatchObject({ addressType: 'ipv4', destination: '127.0.0.1' })
    socket.destroy()
  })

  it('rejects a name the proxy cannot reach', async () => {
    const proxy = await fixture()
    const provider = createSocks5Provider({ host: proxy.host, port: proxy.port })

    await expect(provider.connect('nowhere.test', 443, NEVER)).rejects.toThrow()
  })

  it('tells a proxy that refused the destination from one that could not be reached', async () => {
    const proxy = await fixture()
    const provider = createSocks5Provider({ host: proxy.host, port: proxy.port })
    const refusal = await provider.connect('nowhere.test', 443, NEVER).catch((error: unknown) => error)
    expect(routeAnswered(refusal)).toBe(true)

    const server = createTcpServer()
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const { port } = server.address() as AddressInfo
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    const unreachable = await createSocks5Provider({ host: '127.0.0.1', port }).connect('nowhere.test', 443, NEVER).catch((error: unknown) => error)
    expect(routeAnswered(unreachable)).toBe(false)
    expect(routeAnswered('Socks5 proxy rejected connection')).toBe(false)
  })

  it('keeps the first bytes of a server that speaks first', async () => {
    const target = await echoServer('220 hello\r\n')
    const proxy = await fixture({ coalesceFirstBytes: true, names: { 'mail.test:25': { host: '127.0.0.1', port: target } } })
    const provider = createSocks5Provider({ host: proxy.host, port: proxy.port })

    const socket = await provider.connect('mail.test', 25, NEVER)
    // Read a while after the handshake: the bytes must still be there.
    await new Promise<void>((resolve) => setTimeout(resolve, 50))

    expect(await readOne(socket)).toBe('220 hello\r\n')
    socket.destroy()
  })

  it('rejects when the proxy is not listening', async () => {
    const server = createTcpServer()
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const { port } = server.address() as AddressInfo
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    const provider = createSocks5Provider({ host: '127.0.0.1', port })

    await expect(provider.connect('a.test', 443, NEVER)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('stops a connect still in flight when the signal fires, revoked', async () => {
    const silent = createTcpServer((socket) => { socket.on('error', () => {}); cleanups.push(() => { socket.destroy() }) })
    await new Promise<void>((resolve) => { silent.listen(0, '127.0.0.1', resolve) })
    cleanups.push(async () => { await new Promise<void>((resolve) => { silent.close(() => { resolve() }) }) })
    const provider = createSocks5Provider({ host: '127.0.0.1', port: (silent.address() as AddressInfo).port })
    const abort = new AbortController()

    const pending = provider.connect('a.test', 443, abort.signal)
    setTimeout(() => { abort.abort() }, 30)

    await expect(pending).rejects.toMatchObject({ code: 'revoked' })
  })
})

describe('a signal that has already fired', () => {
  it('opens nothing and rejects revoked', async () => {
    const proxy = await fixture()
    const fired = AbortSignal.abort()

    await expect(createSocks5Provider({ host: proxy.host, port: proxy.port }).connect('a.test', 1, fired)).rejects.toMatchObject({ code: 'revoked' })
    await expect(createSocks5Provider({ host: proxy.host, port: proxy.port }).udp?.(fired)).rejects.toMatchObject({ code: 'revoked' })
    expect(proxy.requests).toEqual([])
  })
})

describe('authentication', () => {
  it('offers no authentication alone when it has no credentials', async () => {
    const target = await echoServer()
    const proxy = await fixture({ names: { 'a.test:1': { host: '127.0.0.1', port: target } } })

    const socket = await createSocks5Provider({ host: proxy.host, port: proxy.port }).connect('a.test', 1, NEVER)

    expect(proxy.requests[0]?.methods).toEqual([0x00])
    socket.destroy()
  })

  it('offers both no authentication and username/password with credentials, and sends them when the proxy chooses them', async () => {
    const target = await echoServer()
    const proxy = await fixture({ preferAuth: true, names: { 'a.test:1': { host: '127.0.0.1', port: target } } })
    const credentials = { userId: 'app-one', password: 'secret-one' }

    const socket = await createSocks5Provider({ host: proxy.host, port: proxy.port, credentials }).connect('a.test', 1, NEVER)

    expect(proxy.requests[0]).toMatchObject({ methods: [0x00, 0x02], chosen: 0x02, userId: 'app-one', password: 'secret-one' })
    socket.destroy()
  })

  it('still connects through a proxy that takes no authentication when it has credentials', async () => {
    const target = await echoServer()
    const proxy = await fixture({ names: { 'a.test:1': { host: '127.0.0.1', port: target } } })
    const credentials = { userId: 'app-one', password: 'secret-one' }

    const socket = await createSocks5Provider({ host: proxy.host, port: proxy.port, credentials }).connect('a.test', 1, NEVER)

    expect(proxy.requests[0]).toMatchObject({ methods: [0x00, 0x02], chosen: 0x00 })
    expect(proxy.requests[0]?.userId).toBeUndefined()
    socket.destroy()
  })

  it('fails against a proxy that requires credentials it was not given', async () => {
    const proxy = await fixture({ requireAuth: true })

    await expect(createSocks5Provider({ host: proxy.host, port: proxy.port }).connect('a.test', 1, NEVER)).rejects.toThrow()
  })

  it('derives credentials that differ per key and per run and repeat within a run', () => {
    const run = isolationCredentials(new Uint8Array(32).fill(1))
    const other = isolationCredentials(new Uint8Array(32).fill(2))

    expect(run('https://one.example')).toEqual(run('https://one.example'))
    expect(run('https://one.example').userId).not.toBe(run('https://two.example').userId)
    expect(run('https://one.example').password).not.toBe(run('https://two.example').password)
    expect(run('https://one.example').password).not.toBe(other('https://one.example').password)
    expect(run('https://one.example').userId).toBe(other('https://one.example').userId)
  })
})

describe('UDP ASSOCIATE', () => {
  it('sends a datagram addressed by name and receives the answer from the relay', async () => {
    const target = await udpEchoServer()
    const proxy = await fixture({ names: { 'udp-name.test:5353': { host: '127.0.0.1', port: target } } })
    const udp = await createSocks5Provider({ host: proxy.host, port: proxy.port }).udp?.(NEVER)
    expect(udp).toBeDefined()
    cleanups.push(async () => { await udp?.close() })
    const received = new Promise<RoutedDatagram>((resolve) => { udp?.onDatagram(resolve) })

    await udp?.send({ host: 'udp-name.test', port: 5353, data: new Uint8Array([1, 2, 3]) })
    const answer = await received

    expect(answer).toMatchObject({ host: 'udp-name.test', port: 5353 })
    expect([...answer.data]).toEqual([1, 2, 3])
    expect(proxy.requests).toMatchObject([{ command: 'associate' }])
    expect(proxy.datagrams).toEqual(['udp-name.test:5353'])
  })

  it('declares the port of its own datagram socket in the request, so a relay can tell its client from any other program', async () => {
    const target = await udpEchoServer()
    const proxy = await fixture({ names: { 'udp-name.test:5353': { host: '127.0.0.1', port: target } } })
    const udp = await createSocks5Provider({ host: proxy.host, port: proxy.port }).udp?.(NEVER)
    cleanups.push(async () => { await udp?.close() })
    const received = new Promise<RoutedDatagram>((resolve) => { udp?.onDatagram(resolve) })
    await udp?.send({ host: 'udp-name.test', port: 5353, data: new Uint8Array([9]) })
    await received

    const asked = proxy.requests.find((request) => request.command === 'associate')
    expect(asked?.destination).toBe('127.0.0.1')
    expect(asked?.port, 'a port, not 0').toBeGreaterThan(0)
  })

  it('sends to the proxy itself when it names the unspecified address as its relay', async () => {
    const target = await udpEchoServer()
    const proxy = await fixture({ unspecifiedRelay: true, names: { 'udp-name.test:5353': { host: '127.0.0.1', port: target } } })
    const udp = await createSocks5Provider({ host: proxy.host, port: proxy.port }).udp?.(NEVER)
    cleanups.push(async () => { await udp?.close() })
    const received = new Promise<RoutedDatagram>((resolve) => { udp?.onDatagram(resolve) })

    await udp?.send({ host: 'udp-name.test', port: 5353, data: new Uint8Array([4]) })

    expect([...(await received).data]).toEqual([4])
  })

  it('connects its local socket to the relay the proxy named, so the kernel takes datagrams from nothing else', async () => {
    const connect = vi.spyOn(DatagramSocket.prototype, 'connect')
    cleanups.push(() => { connect.mockRestore() })
    const target = await udpEchoServer()
    const proxy = await fixture({ names: { 'udp-name.test:5353': { host: '127.0.0.1', port: target } } })
    const udp = await createSocks5Provider({ host: proxy.host, port: proxy.port }).udp?.(NEVER)
    cleanups.push(async () => { await udp?.close() })

    expect(connect).toHaveBeenCalledTimes(1)
    const [relayPort, relayHost] = connect.mock.calls[0] as unknown as [number, string]
    expect(relayHost).toBe('127.0.0.1')
    expect(relayPort).not.toBe(proxy.port)
    const local = (connect.mock.contexts[0] as DatagramSocket).address()

    // A program that is not the relay writes to the socket's port: nothing is delivered.
    const stranger = createSocket('udp4')
    cleanups.push(() => { stranger.close() })
    const heard: RoutedDatagram[] = []
    udp?.onDatagram((datagram) => { heard.push(datagram) })
    const forged = Buffer.concat([Buffer.from([0, 0, 0, 1, 10, 0, 0, 1, 0, 80]), Buffer.from('forged')])
    await new Promise<void>((resolve) => { stranger.send(forged, local.port, '127.0.0.1', () => { resolve() }) })
    await udp?.send({ host: 'udp-name.test', port: 5353, data: new Uint8Array([9]) })
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(heard.map((datagram) => datagram.host)).toEqual(['udp-name.test'])
  })

  it('stays open when the connected socket reports the relay refusing a datagram, which loses that datagram and no more', async () => {
    const connect = vi.spyOn(DatagramSocket.prototype, 'connect')
    cleanups.push(() => { connect.mockRestore() })
    const target = await udpEchoServer()
    const proxy = await fixture({ names: { 'udp-name.test:5353': { host: '127.0.0.1', port: target } } })
    const udp = await createSocks5Provider({ host: proxy.host, port: proxy.port }).udp?.(NEVER)
    cleanups.push(async () => { await udp?.close() })
    let closed = false
    udp?.onClose(() => { closed = true })
    const received = new Promise<RoutedDatagram>((resolve) => { udp?.onDatagram(resolve) })

    ;(connect.mock.contexts[0] as DatagramSocket).emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
    await udp?.send({ host: 'udp-name.test', port: 5353, data: new Uint8Array([7]) })

    expect([...(await received).data]).toEqual([7])
    expect(closed).toBe(false)
  })

  it('rejects when the proxy refuses UDP ASSOCIATE', async () => {
    const proxy = await fixture({ noUdp: true })

    await expect(createSocks5Provider({ host: proxy.host, port: proxy.port }).udp?.(NEVER)).rejects.toThrow()
  })

  it('tells its listeners once when it is closed, and refuses to send afterwards', async () => {
    const proxy = await fixture()
    const udp = await createSocks5Provider({ host: proxy.host, port: proxy.port }).udp?.(NEVER)
    let closes = 0
    udp?.onClose(() => { closes += 1 })

    await udp?.close()
    await udp?.close()

    expect(closes).toBe(1)
    await expect(udp?.send({ host: 'a.test', port: 1, data: new Uint8Array(1) })).rejects.toMatchObject({ code: 'closed' })
  })

  it('ends when the proxy drops the control connection', async () => {
    const proxy = await fixture()
    const udp = await createSocks5Provider({ host: proxy.host, port: proxy.port }).udp?.(NEVER)
    const ended = new Promise<void>((resolve) => { udp?.onClose(resolve) })

    await proxy.close()

    await ended
  })
})
