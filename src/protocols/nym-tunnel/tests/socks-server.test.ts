import { connect as netConnect, createServer } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'
import { createSocket } from 'node:dgram'
import { afterEach, describe, expect, it } from 'vitest'
import { SocksClient } from 'socks'
import { AcquireError } from '../instances.js'
import type { Lease, TcpStream, Tunnel, UdpChannel } from '../instances.js'
import { startSocksServer } from '../socks-server.js'
import type { SocksServer } from '../socks-server.js'

const SECRET = 'a-secret-made-for-this-start'

interface Recorder {
  readonly tcp: string[]
  readonly udpSent: string[]
  readonly acquired: string[]
  released: number
}

/** A tunnel that connects to an echo server on this computer whatever the name, and answers a datagram with the same bytes. */
function fakeTunnel (echoPort: number, record: Recorder, options: { failConnect?: boolean } = {}): Tunnel {
  return {
    connectTcp: async (host, port) => {
      record.tcp.push(`${host}:${String(port)}`)
      if (options.failConnect === true) throw new Error('no route')
      const socket: Socket = netConnect(echoPort, '127.0.0.1')
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
      const chunks: Array<Uint8Array | null> = []
      let wake: (() => void) | undefined
      socket.on('data', (data) => { chunks.push(new Uint8Array(data)); wake?.() })
      socket.on('close', () => { chunks.push(null); wake?.() })
      const stream: TcpStream = {
        read: async () => {
          while (chunks.length === 0) await new Promise<void>((resolve) => { wake = resolve })
          return chunks.shift() ?? null
        },
        write: async (bytes) => { socket.write(bytes) },
        close: async () => { socket.end() }
      }
      return stream
    },
    bindUdp: async () => {
      const queue: Array<{ data: Uint8Array, host: string, port: number }> = []
      let wake: (() => void) | undefined
      let closed = false
      const channel: UdpChannel = {
        sendTo: async (host, port, bytes) => {
          record.udpSent.push(`${host}:${String(port)}`)
          queue.push({ data: bytes, host, port })
          wake?.()
        },
        recv: async (timeoutMs) => {
          const deadline = Date.now() + (timeoutMs ?? 60_000)
          while (queue.length === 0) {
            if (closed) throw new Error('UDP socket closed')
            if (Date.now() > deadline) throw new Error('UDP receive timed out')
            await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, 50) })
          }
          return queue.shift() as { data: Uint8Array, host: string, port: number }
        },
        close: () => { closed = true }
      }
      return channel
    },
    disconnect: async () => {}
  }
}

let servers: Server[] = []
let socks: SocksServer | undefined

async function echoServer (): Promise<number> {
  const server = createServer((socket) => { socket.on('error', () => {}); socket.on('data', (data) => socket.write(data)) })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return (server.address() as AddressInfo).port
}

async function start (acquire: (name: string) => Promise<Lease>, record: Recorder): Promise<number> {
  socks = await startSocksServer(0, { secret: SECRET, acquire: async (name) => { record.acquired.push(name); return await acquire(name) } })
  return socks.port
}

function recorder (): Recorder {
  return { tcp: [], udpSent: [], acquired: [], released: 0 }
}

function leaseOf (tunnel: Tunnel, record: Recorder): Lease {
  return { tunnel, release: () => { record.released += 1 } }
}

afterEach(async () => {
  await socks?.close()
  socks = undefined
  await Promise.all(servers.map(async (server) => await new Promise<void>((resolve) => { server.close(() => { resolve() }) })))
  servers = []
})

const proxyOf = (port: number, password = SECRET, userId = 'app-one'): { host: string, port: number, type: 5, userId: string, password: string } => ({ host: '127.0.0.1', port, type: 5, userId, password })

describe('the SOCKS5 server of the Nym tunnel', () => {
  it('carries a CONNECT by name through the tunnel of the user name, and echoes what the destination sends', async () => {
    const record = recorder()
    const echo = await echoServer()
    const port = await start(async () => leaseOf(fakeTunnel(echo, record), record), record)
    const { socket } = await SocksClient.createConnection({ proxy: proxyOf(port), command: 'connect', destination: { host: 'service.example', port: 4242 } })
    const received = new Promise<string>((resolve) => { socket.once('data', (data) => { resolve(data.toString()) }) })
    socket.write('hello through nym')
    expect(await received).toBe('hello through nym')
    expect(record.tcp).toEqual(['service.example:4242'])
    expect(record.acquired).toEqual(['app-one'])
    socket.destroy()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(record.released).toBe(1)
  })

  it('carries a CONNECT to an address literal too, with the name unresolved here', async () => {
    const record = recorder()
    const echo = await echoServer()
    const port = await start(async () => leaseOf(fakeTunnel(echo, record), record), record)
    const { socket } = await SocksClient.createConnection({ proxy: proxyOf(port), command: 'connect', destination: { host: '93.184.216.34', port: 443 } })
    socket.destroy()
    expect(record.tcp).toEqual(['93.184.216.34:443'])
  })

  it('refuses a wrong secret, and never asks for a tunnel', async () => {
    const record = recorder()
    const port = await start(async () => { throw new Error('must not be asked') }, record)
    await expect(SocksClient.createConnection({ proxy: proxyOf(port, 'not-the-secret'), command: 'connect', destination: { host: 'service.example', port: 80 } })).rejects.toThrow()
    expect(record.acquired).toEqual([])
  })

  it('refuses a user name that is not one an app is given', async () => {
    const record = recorder()
    const port = await start(async () => { throw new Error('must not be asked') }, record)
    await expect(SocksClient.createConnection({ proxy: proxyOf(port, SECRET, '../etc'), command: 'connect', destination: { host: 'service.example', port: 80 } })).rejects.toThrow()
    expect(record.acquired).toEqual([])
  })

  it('offers no way in without a password: a greeting with only "no authentication" is told none is acceptable', async () => {
    const record = recorder()
    const port = await start(async () => { throw new Error('must not be asked') }, record)
    const answer = await new Promise<Buffer>((resolve) => {
      const socket = netConnect(port, '127.0.0.1', () => { socket.write(Buffer.from([5, 1, 0])) })
      socket.once('data', (data) => { resolve(data); socket.destroy() })
    })
    expect([...answer]).toEqual([5, 0xff])
  })

  it('does not support BIND', async () => {
    const record = recorder()
    const port = await start(async () => leaseOf(fakeTunnel(0, record), record), record)
    await expect(SocksClient.createConnection({ proxy: proxyOf(port), command: 'bind', destination: { host: '0.0.0.0', port: 0 } })).rejects.toThrow(/CommandNotSupported|command/i)
    expect(record.acquired).toEqual(['app-one'].slice(0, 0))
  })

  it('answers a destination the tunnel cannot reach as unreachable, and gives the tunnel back', async () => {
    const record = recorder()
    const echo = await echoServer()
    const port = await start(async () => leaseOf(fakeTunnel(echo, record, { failConnect: true }), record), record)
    await expect(SocksClient.createConnection({ proxy: proxyOf(port), command: 'connect', destination: { host: 'service.example', port: 80 } })).rejects.toThrow(/HostUnreachable/i)
    expect(record.released).toBe(1)
  })

  it('refuses an app past the cap as not allowed, and closes the connection of a tunnel that did not come up', async () => {
    const record = recorder()
    let kind: 'cap' | 'start-failed' = 'cap'
    const port = await start(async () => { throw new AcquireError(kind, 'why') }, record)
    await expect(SocksClient.createConnection({ proxy: proxyOf(port), command: 'connect', destination: { host: 'service.example', port: 80 } })).rejects.toThrow(/NotAllowed/i)
    kind = 'start-failed'
    await expect(SocksClient.createConnection({ proxy: proxyOf(port), command: 'connect', destination: { host: 'service.example', port: 80 } })).rejects.toThrow()
  })

  it('carries UDP ASSOCIATE through the tunnel, the relay being on loopback and the datagrams only the client\'s', async () => {
    const record = recorder()
    const port = await start(async () => leaseOf(fakeTunnel(0, record), record), record)
    const client = new SocksClient({ proxy: proxyOf(port), command: 'associate', destination: { host: '0.0.0.0', port: 0 } })
    const { socket, remoteHost } = await new Promise<{ socket: Socket, remoteHost?: { host: string, port: number } }>((resolve, reject) => {
      client.once('established', resolve)
      client.once('error', reject)
      client.connect()
    })
    expect(remoteHost?.host).toBe('127.0.0.1')
    const udp = createSocket('udp4')
    await new Promise<void>((resolve) => { udp.bind(0, '127.0.0.1', resolve) })
    const answer = new Promise<{ host: string, port: number, data: string }>((resolve) => {
      udp.once('message', (message) => {
        const frame = SocksClient.parseUDPFrame(message)
        resolve({ host: frame.remoteHost.host, port: frame.remoteHost.port, data: frame.data.toString() })
      })
    })
    udp.send(SocksClient.createUDPFrame({ remoteHost: { host: 'dns.example', port: 53 }, data: Buffer.from('query') }), remoteHost?.port ?? 0, '127.0.0.1')
    expect(await answer).toEqual({ host: 'dns.example', port: 53, data: 'query' })
    expect(record.udpSent).toEqual(['dns.example:53'])

    // A second socket cannot use the association the first one fixed.
    const stranger = createSocket('udp4')
    await new Promise<void>((resolve) => { stranger.bind(0, '127.0.0.1', resolve) })
    stranger.send(SocksClient.createUDPFrame({ remoteHost: { host: 'other.example', port: 53 }, data: Buffer.from('x') }), remoteHost?.port ?? 0, '127.0.0.1')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(record.udpSent).toEqual(['dns.example:53'])

    socket.destroy()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(record.released).toBe(1)
    udp.close()
    stranger.close()
  })
})
