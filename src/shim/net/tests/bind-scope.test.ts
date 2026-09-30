import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { TcpServer, UdpSocket } from '../../../contracts/handles.js'
import type { BindScope } from '../../../contracts/index.js'
import { createFakeTcpServer } from '../../tests/support/fake-tcp-server.js'
import { createFakeUdpSocket } from '../../tests/support/fake-udp-socket.js'
import { OrivonShimError } from '../../errors.js'
import { Server } from '../server.js'
import type { NetListenFn } from '../server.js'
import { Socket } from '../dgram-socket.js'

// What Node code's host or address asks the broker for, and what `address()`
// then reports: the real, narrower one when the network scope was refused.

const denied = (): Error => Object.assign(new Error('no network grant'), { code: 'denied' })

/** A `listen` that refuses the network scope and serves local at loopback, as a broker holding only `tcp.listen.local` does. */
function localOnlyListen (): { listen: Mock<NetListenFn>, fake: ReturnType<typeof createFakeTcpServer> } {
  const fake = createFakeTcpServer({ localAddress: '127.0.0.1', localPort: 6881 })
  const listen = vi.fn<NetListenFn>(async (opts) => {
    if (opts.scope === 'network') throw denied()
    return fake.server as TcpServer
  })
  return { listen, fake }
}

async function listening (server: Server, ...args: unknown[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(...args, resolve)
  })
}

describe('net.Server#listen -- the scope a host asks for', () => {
  it.each(['127.0.0.1', 'localhost', '::1'])('%s asks for local only, and is not retried wider', async (host) => {
    const listen = vi.fn<NetListenFn>(async () => createFakeTcpServer().server as TcpServer)
    await listening(new Server(listen), 6881, host)
    expect(listen.mock.calls).toEqual([[{ port: 6881, scope: 'local' }]])
  })

  it.each([undefined, '0.0.0.0', '::'])('host %s asks for the network scope', async (host) => {
    const listen = vi.fn<NetListenFn>(async () => createFakeTcpServer().server as TcpServer)
    const server = new Server(listen)
    await listening(server, ...(host === undefined ? [6881] : [6881, host]))
    expect(listen.mock.calls).toEqual([[{ port: 6881, scope: 'network' }]])
  })

  it('takes the host from an options object too', async () => {
    const listen = vi.fn<NetListenFn>(async () => createFakeTcpServer().server as TcpServer)
    await listening(new Server(listen), { port: 6881, host: 'localhost' })
    expect(listen.mock.calls).toEqual([[{ port: 6881, scope: 'local' }]])
  })

  it('holding only the local grant, an app with no host is not refused: it gets loopback, and address() says so', async () => {
    const { listen } = localOnlyListen()
    const server = new Server(listen)
    await listening(server, 6881)
    expect(listen.mock.calls.map(([opts]) => opts.scope)).toEqual(['network', 'local'])
    expect(server.address()).toEqual({ address: '127.0.0.1', port: 6881, family: 'IPv4' })
  })

  it('the same fallback serves 0.0.0.0 and ::', async () => {
    for (const host of ['0.0.0.0', '::']) {
      const { listen } = localOnlyListen()
      const server = new Server(listen)
      await listening(server, 6881, host)
      expect(server.address()?.address).toBe('127.0.0.1')
    }
  })

  it('an app holding the network grant, with no host, is served on the network scope with no second attempt', async () => {
    const fake = createFakeTcpServer({ localAddress: '0.0.0.0', localPort: 6881 })
    const listen = vi.fn<NetListenFn>(async () => fake.server as TcpServer)
    const server = new Server(listen)
    await listening(server, 6881)
    expect(listen).toHaveBeenCalledTimes(1)
    expect(server.address()?.address).toBe('0.0.0.0')
  })

  it('an explicit loopback host with no grant at all reports the denial as an error event', async () => {
    const listen = vi.fn<NetListenFn>(async () => { throw denied() })
    const server = new Server(listen)
    const failure = new Promise<Error & { code?: string }>((resolve) => server.once('error', resolve))
    server.listen(6881, '127.0.0.1')
    expect((await failure).code).toBe('denied')
    expect(listen).toHaveBeenCalledTimes(1)
  })

  it('a host that is one other address is still refused by name, before the broker is asked', () => {
    const listen = vi.fn<NetListenFn>(async () => createFakeTcpServer().server as TcpServer)
    expect(() => new Server(listen).listen(6881, '192.168.1.5')).toThrow(OrivonShimError)
    expect(listen).not.toHaveBeenCalled()
  })
})

describe('dgram.Socket#bind -- the scope an address asks for', () => {
  const bound = (): ReturnType<typeof createFakeUdpSocket> => createFakeUdpSocket({ localAddress: '127.0.0.1', localPort: 6881 })

  it.each([['127.0.0.1'], ['localhost'], ['::1']])('bind(port, %s) asks for local only', async (address) => {
    const bindFn = vi.fn(async () => bound().socket as UdpSocket)
    const socket = new Socket(bindFn)
    const listening = new Promise<void>((resolve) => socket.once('listening', resolve))
    socket.bind(6881, address)
    await listening
    expect(bindFn.mock.calls).toEqual([[{ port: 6881, scope: 'local' }]])
  })

  it('bind({ port, address }) reads the address from the options object', async () => {
    const bindFn = vi.fn(async () => bound().socket as UdpSocket)
    const socket = new Socket(bindFn)
    const listening = new Promise<void>((resolve) => socket.once('listening', resolve))
    socket.bind({ port: 6881, address: '127.0.0.1' })
    await listening
    expect(bindFn.mock.calls).toEqual([[{ port: 6881, scope: 'local' }]])
  })

  it.each([[undefined], ['0.0.0.0'], ['::'], ['']])('bind(port, %j) asks for the network scope', async (address) => {
    const bindFn = vi.fn(async () => bound().socket as UdpSocket)
    const socket = new Socket(bindFn)
    const listening = new Promise<void>((resolve) => socket.once('listening', resolve))
    if (address === undefined) socket.bind(6881)
    else socket.bind(6881, address)
    await listening
    expect(bindFn.mock.calls).toEqual([[{ port: 6881, scope: 'network' }]])
  })

  it('holding only the local grant, a bind with no address falls back to loopback and address() reports it', async () => {
    const fake = bound()
    const bindFn = vi.fn(async (opts: { port: number, scope: BindScope }) => {
      if (opts.scope === 'network') throw denied()
      return fake.socket as UdpSocket
    })
    const socket = new Socket(bindFn)
    const listening = new Promise<void>((resolve) => socket.once('listening', resolve))
    socket.bind(6881)
    await listening
    expect(bindFn.mock.calls.map(([opts]) => opts.scope)).toEqual(['network', 'local'])
    expect(socket.address()).toEqual({ address: '127.0.0.1', port: 6881, family: 'IPv4' })
  })

  it('an address that is one other interface is refused by name, before the broker is asked', () => {
    const bindFn = vi.fn(async () => bound().socket as UdpSocket)
    expect(() => new Socket(bindFn).bind(6881, '192.168.1.5')).toThrow(OrivonShimError)
    expect(bindFn).not.toHaveBeenCalled()
  })
})
