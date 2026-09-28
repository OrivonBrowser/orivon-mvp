// wasi:sockets over a fake orivon.net, driven the way jco's glue calls the
// host: start, poll until ready, finish.

import { describe, expect, it, vi } from 'vitest'
import type { TcpServer, TcpSocket as OrivonTcpSocket, UdpSocket as OrivonUdpSocket } from '../../../contracts/handles.js'
import { createFakeTcpServer } from '../../tests/support/fake-tcp-server.js'
import { createFakeTcpSocket } from '../../tests/support/fake-tcp-socket.js'
import { createFakeUdpSocket } from '../../tests/support/fake-udp-socket.js'
import type { IpSocketAddress, SocketNet } from '../addresses.js'
import type { InputStream, OutputStream } from '../io.js'
import { socketInterfaces } from '../sockets.js'
import type { TcpSocket } from '../tcp.js'
import type { UdpSocket } from '../udp.js'

const v4 = (a: number, b: number, c: number, d: number, port: number): IpSocketAddress => ({ tag: 'ipv4', val: { port, address: [a, b, c, d] } })

function fakeNet (overrides: Partial<SocketNet> = {}): SocketNet & { connect: ReturnType<typeof vi.fn> } {
  return {
    connect: vi.fn(async () => createFakeTcpSocket({ remoteAddress: '93.184.216.34', remotePort: 443 }).socket as OrivonTcpSocket),
    listen: vi.fn(async () => createFakeTcpServer().server as TcpServer),
    udpBind: vi.fn(async () => createFakeUdpSocket().socket as OrivonUdpSocket),
    lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 'IPv4' as const }]),
    ...overrides
  } as SocketNet & { connect: ReturnType<typeof vi.fn> }
}

type Interfaces = ReturnType<typeof socketInterfaces>
const fn = <T>(interfaces: Interfaces, iface: string, name: string): T => interfaces[iface]?.[name] as T

async function resolve (interfaces: Interfaces, name: string): Promise<unknown[]> {
  const network = fn<() => unknown>(interfaces, 'wasi:sockets/instance-network', 'instanceNetwork')()
  const stream = fn<(network: unknown, name: string) => { resolveNextAddress: () => unknown, subscribe: () => { block: () => Promise<void> } }>(interfaces, 'wasi:sockets/ip-name-lookup', 'resolveAddresses')(network, name)
  await stream.subscribe().block()
  const found: unknown[] = []
  for (let next = stream.resolveNextAddress(); next !== undefined; next = stream.resolveNextAddress()) found.push(next)
  return found
}

function createTcp (interfaces: Interfaces): TcpSocket {
  return fn<(family: string) => TcpSocket>(interfaces, 'wasi:sockets/tcp-create-socket', 'createTcpSocket')('ipv4')
}

describe('TCP', () => {
  it('connects by the name the program resolved, so the broker checks the host grant', async () => {
    const net = fakeNet()
    const interfaces = socketInterfaces(net)
    expect(await resolve(interfaces, 'example.com')).toEqual([{ tag: 'ipv4', val: [93, 184, 216, 34] }])
    const socket = createTcp(interfaces)
    socket.startConnect({}, v4(93, 184, 216, 34, 443))
    expect(() => socket.finishConnect()).toThrow('would-block')
    await socket.subscribe().block()
    const [input, output]: [InputStream, OutputStream] = socket.finishConnect()
    expect(net.connect).toHaveBeenCalledWith({ host: 'example.com', port: 443 })
    expect(input.read(1n)).toEqual(new Uint8Array(0))
    expect(output.checkWrite()).toBeGreaterThan(0n)
    expect(socket.remoteAddress()).toEqual(v4(93, 184, 216, 34, 443))
  })

  it('connects to an address the program did not resolve as that address, for the broker to decide', async () => {
    const net = fakeNet()
    const socket = createTcp(socketInterfaces(net))
    socket.startConnect({}, v4(10, 0, 0, 7, 8080))
    await socket.subscribe().block()
    socket.finishConnect()
    expect(net.connect).toHaveBeenCalledWith({ host: '10.0.0.7', port: 8080 })
  })

  it('reports a refused connect as its error code once finished, and closes the socket', async () => {
    const socket = createTcp(socketInterfaces(fakeNet({ connect: async () => { throw Object.assign(new Error('no'), { code: 'denied' }) } })))
    socket.startConnect({}, v4(1, 2, 3, 4, 80))
    await socket.subscribe().block()
    expect(() => socket.finishConnect()).toThrow('access-denied')
    expect(() => socket.startConnect({}, v4(1, 2, 3, 4, 80))).toThrow('invalid-state')
  })

  it('refuses what WASI refuses before any call: port 0, the unspecified address, another family, a second connect', () => {
    const socket = createTcp(socketInterfaces(fakeNet()))
    expect(() => { socket.startConnect({}, v4(1, 2, 3, 4, 0)) }).toThrow('invalid-argument')
    expect(() => { socket.startConnect({}, v4(0, 0, 0, 0, 80)) }).toThrow('invalid-argument')
    expect(() => { socket.startConnect({}, { tag: 'ipv6', val: { port: 80, flowInfo: 0, address: [0, 0, 0, 0, 0, 0, 0, 1], scopeId: 0 } }) }).toThrow('invalid-argument')
    expect(() => socket.finishConnect()).toThrow('invalid-state')
  })

  it('binds at listen, in the scope its address names, and accepts each connection as it arrives', async () => {
    const fake = createFakeTcpServer({ localAddress: '127.0.0.1', localPort: 4001 })
    const net = fakeNet({ listen: vi.fn(async () => fake.server as TcpServer) })
    const socket = createTcp(socketInterfaces(net))
    socket.startBind({}, v4(127, 0, 0, 1, 4001))
    socket.finishBind()
    socket.startListen()
    await socket.subscribe().block()
    socket.finishListen()
    expect(net.listen).toHaveBeenCalledWith({ port: 4001, scope: 'local' })
    expect(socket.isListening()).toBe(true)
    expect(() => socket.accept()).toThrow('would-block')
    const pollable = socket.subscribe()
    expect(pollable.ready()).toBe(false)
    await vi.waitFor(() => { expect(fake.pullCount()).toBeGreaterThan(0) })
    fake.deliver(createFakeTcpSocket({ remoteAddress: '127.0.0.1', remotePort: 5555 }).socket)
    await pollable.block()
    const [peer] = socket.accept()
    expect(peer.remoteAddress()).toEqual(v4(127, 0, 0, 1, 5555))
    expect(socket.localAddress()).toEqual(v4(127, 0, 0, 1, 4001))
  })

  it('carries bytes both ways over a connected socket, and shuts down its send side with a FIN', async () => {
    const fake = createFakeTcpSocket()
    const socket = createTcp(socketInterfaces(fakeNet({ connect: async () => fake.socket })))
    socket.startConnect({}, v4(1, 2, 3, 4, 80))
    await socket.subscribe().block()
    const [input, output] = socket.finishConnect()
    fake.push(new TextEncoder().encode('pong'))
    expect(new TextDecoder().decode(await input.blockingRead(10n))).toBe('pong')
    await output.blockingWriteAndFlush(new TextEncoder().encode('ping'))
    expect(new TextDecoder().decode(fake.written[0])).toBe('ping')
    socket.shutdown('send')
    await vi.waitFor(() => { expect(fake.finSent()).toBe(true) })
  })
})

describe('UDP', () => {
  it('binds, receives what arrives from its connected peer only, and sends by the resolved name', async () => {
    const fake = createFakeUdpSocket({ localAddress: '0.0.0.0', localPort: 5353 })
    const net = fakeNet({ udpBind: vi.fn(async () => fake.socket as OrivonUdpSocket) })
    const interfaces = socketInterfaces(net)
    await resolve(interfaces, 'example.com')
    const socket = fn<(family: string) => UdpSocket>(interfaces, 'wasi:sockets/udp-create-socket', 'createUdpSocket')('ipv4')
    socket.startBind({}, v4(0, 0, 0, 0, 5353))
    expect(() => { socket.finishBind() }).toThrow('would-block')
    await socket.subscribe().block()
    socket.finishBind()
    expect(net.udpBind).toHaveBeenCalledWith({ port: 5353, scope: 'network' })
    const [incoming, outgoing] = socket.stream(v4(93, 184, 216, 34, 53))
    fake.deliver({ data: new Uint8Array([9]), address: '6.6.6.6', port: 53, family: 'IPv4' })
    fake.deliver({ data: new Uint8Array([1, 2]), address: '93.184.216.34', port: 53, family: 'IPv4' })
    await incoming.subscribe().block()
    expect(incoming.receive(10n)).toEqual([{ data: new Uint8Array([1, 2]), remoteAddress: v4(93, 184, 216, 34, 53) }])
    expect(outgoing.checkSend()).toBeGreaterThan(0n)
    expect(outgoing.send([{ data: new Uint8Array([7]) }])).toBe(1n)
    await vi.waitFor(() => { expect(fake.sent).toHaveLength(1) })
    expect(fake.sent[0]).toMatchObject({ address: 'example.com', port: 53 })
    expect(() => socket.stream(undefined)).toThrow('not-supported')
  })
})

describe('name lookup', () => {
  it('answers an address literal at once, and a failed lookup as name-unresolvable', async () => {
    const interfaces = socketInterfaces(fakeNet({ lookup: async () => { throw Object.assign(new Error('nx'), { code: 'notFound' }) } }))
    expect(await resolve(interfaces, '::1')).toEqual([{ tag: 'ipv6', val: [0, 0, 0, 0, 0, 0, 0, 1] }])
    await expect(resolve(interfaces, 'nowhere.invalid')).rejects.toBe('name-unresolvable')
  })
})
