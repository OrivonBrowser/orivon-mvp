// A SOCKS5 proxy on loopback for tests: CONNECT by domain name, UDP ASSOCIATE,
// username/password authentication on request, and a log of everything it was
// asked. A name resolves only inside this server, through `names`, so a client
// that resolved the name itself would fail or land somewhere else. Not
// *.test.ts, so vitest does not collect it as a suite.

import { connect as netConnect, createServer, isIP } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'
import { createSocket } from 'node:dgram'
import type { Socket as DgramSocket } from 'node:dgram'

export interface Target { readonly host: string, readonly port: number }

export interface Socks5Request {
  readonly command: 'connect' | 'associate'
  readonly destination: string
  readonly port: number
  readonly addressType: 'domain' | 'ipv4' | 'ipv6'
  /** The authentication methods the client offered in its greeting. */
  readonly methods: readonly number[]
  /** The method the server chose. */
  readonly chosen: number
  readonly userId?: string
  readonly password?: string
}

export interface Socks5FixtureOptions {
  /** `"name:port"` to the local server a CONNECT or UDP datagram for that name reaches. */
  readonly names?: Readonly<Record<string, Target>>
  /** Refuse a greeting that does not offer username/password. */
  readonly requireAuth?: boolean
  /** When both methods are offered, choose username/password (what Tor does when isolating by credentials). */
  readonly preferAuth?: boolean
  /** Answer UDP ASSOCIATE with "command not supported". */
  readonly noUdp?: boolean
  /** Answer UDP ASSOCIATE with the unspecified address, meaning "where you reached me". */
  readonly unspecifiedRelay?: boolean
  /** Send the target's first bytes in the same write as the CONNECT reply, as a proxy relaying a server that speaks first can. */
  readonly coalesceFirstBytes?: boolean
}

export interface Socks5Fixture {
  readonly host: string
  readonly port: number
  /** One entry per completed request, in order. */
  readonly requests: Socks5Request[]
  /** Every datagram forwarded for a client, as `"name:port"`. */
  readonly datagrams: string[]
  close: () => Promise<void>
}

const NO_AUTH = 0x00
const USER_PASS = 0x02
const NO_ACCEPTABLE = 0xff

interface Reader {
  read: (count: number) => Promise<Buffer>
  rest: () => Buffer
}

function readerOf (socket: Socket): Reader {
  let buffered = Buffer.alloc(0)
  let wake: (() => void) | undefined
  let ended = false
  socket.on('data', (chunk: Buffer) => { buffered = Buffer.concat([buffered, chunk]); wake?.() })
  socket.on('close', () => { ended = true; wake?.() })
  socket.on('error', () => { ended = true; wake?.() })
  return {
    read: async (count) => {
      while (buffered.length < count) {
        if (ended) throw new Error('closed')
        await new Promise<void>((resolve) => { wake = resolve })
      }
      const out = buffered.subarray(0, count)
      buffered = buffered.subarray(count)
      return out
    },
    rest: () => { const out = buffered; buffered = Buffer.alloc(0); return out }
  }
}

function reply (code: number, bound: Target = { host: '0.0.0.0', port: 0 }): Buffer {
  const address = Buffer.from(bound.host.split('.').map(Number))
  const port = Buffer.alloc(2)
  port.writeUInt16BE(bound.port)
  return Buffer.concat([Buffer.from([0x05, code, 0x00, 0x01]), address, port])
}

interface Destination { readonly host: string, readonly port: number, readonly type: Socks5Request['addressType'] }

async function readDestination (read: Reader['read'], atyp: number): Promise<Destination> {
  let host: string
  let type: Socks5Request['addressType']
  if (atyp === 0x01) {
    host = [...await read(4)].join('.')
    type = 'ipv4'
  } else if (atyp === 0x03) {
    const length = (await read(1))[0] ?? 0
    host = (await read(length)).toString('utf8')
    type = 'domain'
  } else {
    const raw = await read(16)
    host = Array.from({ length: 8 }, (_, i) => raw.readUInt16BE(i * 2).toString(16)).join(':')
    type = 'ipv6'
  }
  const port = (await read(2)).readUInt16BE()
  return { host, port, type }
}

/** The UDP frame header (RFC 1928 section 7) read from `data`, and the payload after it. */
function parseFrame (data: Buffer): { destination: Destination, payload: Buffer } | undefined {
  if (data.length < 10 || data[2] !== 0) return undefined
  const atyp = data[3]
  let offset = 4
  let host: string
  let type: Socks5Request['addressType']
  if (atyp === 0x01) {
    host = [...data.subarray(4, 8)].join('.')
    type = 'ipv4'
    offset = 8
  } else if (atyp === 0x03) {
    const length = data[4] ?? 0
    host = data.subarray(5, 5 + length).toString('utf8')
    type = 'domain'
    offset = 5 + length
  } else {
    return undefined
  }
  return { destination: { host, port: data.readUInt16BE(offset), type }, payload: data.subarray(offset + 2) }
}

function frameFrom (name: Destination, payload: Buffer): Buffer {
  const port = Buffer.alloc(2)
  port.writeUInt16BE(name.port)
  const address = isIP(name.host) === 4
    ? Buffer.concat([Buffer.from([0x01]), Buffer.from(name.host.split('.').map(Number))])
    : Buffer.concat([Buffer.from([0x03, Buffer.byteLength(name.host)]), Buffer.from(name.host)])
  return Buffer.concat([Buffer.from([0, 0, 0]), address, port, payload])
}

function closeRelay (relay: DgramSocket): void {
  try { relay.close() } catch { /* already closed */ }
}

export async function startSocks5Fixture (options: Socks5FixtureOptions = {}): Promise<Socks5Fixture> {
  const requests: Socks5Request[] = []
  const datagrams: string[] = []
  const names = options.names ?? {}
  const sockets = new Set<Socket>()
  const relays = new Set<DgramSocket>()

  async function serve (socket: Socket): Promise<void> {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    const { read, rest } = readerOf(socket)

    const greeting = await read(2)
    const methods = [...await read(greeting[1] ?? 0)]
    let chosen = NO_ACCEPTABLE
    if (options.requireAuth === true) chosen = methods.includes(USER_PASS) ? USER_PASS : NO_ACCEPTABLE
    else if (options.preferAuth === true && methods.includes(USER_PASS)) chosen = USER_PASS
    else if (methods.includes(NO_AUTH)) chosen = NO_AUTH
    else if (methods.includes(USER_PASS)) chosen = USER_PASS
    socket.write(Buffer.from([0x05, chosen]))
    if (chosen === NO_ACCEPTABLE) { socket.end(); return }

    let userId: string | undefined
    let password: string | undefined
    if (chosen === USER_PASS) {
      await read(1)
      userId = (await read((await read(1))[0] ?? 0)).toString('utf8')
      password = (await read((await read(1))[0] ?? 0)).toString('utf8')
      socket.write(Buffer.from([0x01, 0x00]))
    }

    const head = await read(4)
    const destination = await readDestination(read, head[3] ?? 0)
    const record = (command: Socks5Request['command']): void => {
      requests.push({
        command,
        destination: destination.host,
        port: destination.port,
        addressType: destination.type,
        methods,
        chosen,
        ...(userId === undefined ? {} : { userId }),
        ...(password === undefined ? {} : { password })
      })
    }

    if (head[1] === 0x01) {
      record('connect')
      const target = destination.type === 'domain' ? names[`${destination.host}:${String(destination.port)}`] : { host: destination.host, port: destination.port }
      if (target === undefined) { socket.write(reply(0x04)); socket.end(); return }
      const upstream = netConnect(target)
      sockets.add(upstream)
      upstream.on('close', () => sockets.delete(upstream))
      upstream.on('error', () => { if (!socket.destroyed) { socket.write(reply(0x05)); socket.end() } })
      const open = (first: Buffer): void => {
        socket.write(Buffer.concat([reply(0x00), first]))
        const early = rest()
        if (early.length > 0) upstream.write(early)
        socket.pipe(upstream)
        upstream.pipe(socket)
      }
      if (options.coalesceFirstBytes === true) upstream.once('data', open)
      else upstream.once('connect', () => { open(Buffer.alloc(0)) })
      socket.on('close', () => upstream.destroy())
      return
    }

    if (head[1] !== 0x03 || options.noUdp === true) { socket.write(reply(0x07)); socket.end(); return }
    record('associate')
    const relay = createSocket('udp4')
    relays.add(relay)
    await new Promise<void>((resolve) => { relay.bind(0, '127.0.0.1', resolve) })
    socket.write(reply(0x00, { host: options.unspecifiedRelay === true ? '0.0.0.0' : '127.0.0.1', port: relay.address().port }))
    socket.on('close', () => { closeRelay(relay); relays.delete(relay) })

    let client: { address: string, port: number } | undefined
    const origins = new Map<string, Destination>()
    relay.on('message', (data, from) => {
      const origin = origins.get(`${from.address}:${String(from.port)}`)
      if (origin !== undefined) {
        if (client !== undefined) relay.send(frameFrom(origin, data), client.port, client.address)
        return
      }
      client ??= { address: from.address, port: from.port }
      const frame = parseFrame(data)
      if (frame === undefined) return
      const key = `${frame.destination.host}:${String(frame.destination.port)}`
      const target = frame.destination.type === 'domain' ? names[key] : { host: frame.destination.host, port: frame.destination.port }
      if (target === undefined) return
      datagrams.push(key)
      origins.set(`${target.host}:${String(target.port)}`, frame.destination)
      relay.send(frame.payload, target.port, target.host)
    })
  }

  const server: Server = createServer((socket) => { serve(socket).catch(() => { socket.destroy() }) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    host: '127.0.0.1',
    port,
    requests,
    datagrams,
    close: async () => {
      for (const open of sockets) open.destroy()
      for (const open of relays) closeRelay(open)
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  }
}
