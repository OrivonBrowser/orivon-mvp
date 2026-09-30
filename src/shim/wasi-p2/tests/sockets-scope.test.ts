// A WASI component's bind address asks for a scope, and a refused network
// scope falls back to loopback, as the Node shim's does.

import { describe, expect, it, vi } from 'vitest'
import type { TcpServer, TcpSocket as OrivonTcpSocket, UdpSocket as OrivonUdpSocket } from '../../../contracts/handles.js'
import type { BindScope } from '../../../contracts/index.js'
import { createFakeTcpServer } from '../../tests/support/fake-tcp-server.js'
import { createFakeTcpSocket } from '../../tests/support/fake-tcp-socket.js'
import { createFakeUdpSocket } from '../../tests/support/fake-udp-socket.js'
import type { IpSocketAddress, SocketNet } from '../addresses.js'
import { socketInterfaces } from '../sockets.js'
import type { TcpSocket } from '../tcp.js'
import type { UdpSocket } from '../udp.js'

const v4 = (a: number, b: number, c: number, d: number, port: number): IpSocketAddress => ({ tag: 'ipv4', val: { port, address: [a, b, c, d] } })
const denied = (): Error => Object.assign(new Error('no network grant'), { code: 'denied' })

/** A net that serves `local` at loopback and refuses `network`, as a broker holding only the local grants does. */
function localOnlyNet (): SocketNet & { listen: ReturnType<typeof vi.fn>, udpBind: ReturnType<typeof vi.fn> } {
  return {
    connect: vi.fn(async () => createFakeTcpSocket().socket as OrivonTcpSocket),
    listen: vi.fn(async (opts: { scope: BindScope }) => {
      if (opts.scope === 'network') throw denied()
      return createFakeTcpServer({ localAddress: '127.0.0.1', localPort: 4001 }).server as TcpServer
    }),
    udpBind: vi.fn(async (opts: { scope: BindScope }) => {
      if (opts.scope === 'network') throw denied()
      return createFakeUdpSocket({ localAddress: '127.0.0.1', localPort: 5353 }).socket as OrivonUdpSocket
    }),
    lookup: vi.fn(async () => [])
  } as never
}

const tcp = (net: SocketNet): TcpSocket => (socketInterfaces(net)['wasi:sockets/tcp-create-socket']?.createTcpSocket as (family: string) => TcpSocket)('ipv4')
const udp = (net: SocketNet): UdpSocket => (socketInterfaces(net)['wasi:sockets/udp-create-socket']?.createUdpSocket as (family: string) => UdpSocket)('ipv4')

async function listenAt (net: SocketNet, address: IpSocketAddress): Promise<TcpSocket> {
  const socket = tcp(net)
  socket.startBind({}, address)
  socket.finishBind()
  socket.startListen()
  await socket.finishListen()
  return socket
}

describe('wasi:sockets/tcp listen', () => {
  it('a loopback address asks for local and is not retried', async () => {
    const net = localOnlyNet()
    const socket = await listenAt(net, v4(127, 0, 0, 1, 4001))
    expect(net.listen.mock.calls).toEqual([[{ port: 4001, scope: 'local' }]])
    expect(socket.localAddress()).toEqual(v4(127, 0, 0, 1, 4001))
  })

  it('0.0.0.0 asks for network, falls back to local when refused, and reports the loopback address it got', async () => {
    const net = localOnlyNet()
    const socket = await listenAt(net, v4(0, 0, 0, 0, 4001))
    expect(net.listen.mock.calls).toEqual([[{ port: 4001, scope: 'network' }], [{ port: 4001, scope: 'local' }]])
    expect(socket.localAddress()).toEqual(v4(127, 0, 0, 1, 4001))
  })

  it('a listen refused for a reason other than denial is not retried', async () => {
    const inUse = Object.assign(new Error('in use'), { code: 'failed', platformCode: 'EADDRINUSE' })
    const net = localOnlyNet()
    net.listen.mockImplementation(async () => { throw inUse })
    const socket = tcp(net)
    socket.startBind({}, v4(0, 0, 0, 0, 4001))
    socket.finishBind()
    socket.startListen()
    await expect(socket.finishListen()).rejects.toBe('address-in-use')
    expect(net.listen).toHaveBeenCalledTimes(1)
  })
})

describe('wasi:sockets/udp bind', () => {
  it('a loopback address asks for local and is not retried', async () => {
    const net = localOnlyNet()
    const socket = udp(net)
    socket.startBind({}, v4(127, 0, 0, 1, 5353))
    await socket.finishBind()
    expect(net.udpBind.mock.calls).toEqual([[{ port: 5353, scope: 'local' }]])
  })

  it('0.0.0.0 asks for network and falls back to local when refused', async () => {
    const net = localOnlyNet()
    const socket = udp(net)
    socket.startBind({}, v4(0, 0, 0, 0, 5353))
    await socket.finishBind()
    expect(net.udpBind.mock.calls).toEqual([[{ port: 5353, scope: 'network' }], [{ port: 5353, scope: 'local' }]])
    expect(socket.localAddress()).toEqual(v4(127, 0, 0, 1, 5353))
  })
})
