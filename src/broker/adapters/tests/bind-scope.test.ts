import { createSocket } from 'node:dgram'
import type { Socket as DgramSocket } from 'node:dgram'
import { connect as netConnect } from 'node:net'
import { networkInterfaces } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createBroker } from '../../index.js'
import type { Broker, BoundUdpSocket, ListenedServer } from '../../broker-contracts.js'
import type { BindScope } from '../../../contracts/index.js'
import { listenTcp, nodeFs } from '../node-adapters.js'
import { bindUdp } from '../udp-adapter.js'

// ADR-0034 against REAL sockets: what a `'local'` bind reaches, and what a
// `'network'` one does. "Reaches" is measured from this machine's own
// non-loopback IPv4 address, which is the closest a single host gets to
// "another device on the network": the kernel delivers a packet addressed to
// it only to a socket bound to that address or to every address.

/** This machine's first non-loopback IPv4 address, or undefined on a machine that has none. */
function lanAddress (): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return undefined
}

const LAN = lanAddress()

/** Runs `body` with the LAN address, or logs why the assertion is skipped on a machine without one. */
async function withLan (body: (lan: string) => Promise<void>): Promise<void> {
  if (LAN === undefined) {
    console.info('bind-scope.test: no non-loopback IPv4 address on this machine; the "not reachable via the LAN address" assertion is skipped')
    return
  }
  await body(LAN)
}

function neverAborts (): AbortSignal {
  return new AbortController().signal
}

/** Whether a TCP connection to `host:port` is accepted (true) or refused/times out (false). */
async function tcpReaches (host: string, port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = netConnect({ host, port })
    const done = (reached: boolean): void => { socket.destroy(); resolve(reached) }
    socket.once('connect', () => { done(true) })
    socket.once('error', () => { done(false) })
    socket.setTimeout(1000, () => { done(false) })
  })
}

/** Whether a datagram sent to `host:port` arrives on `bound`'s readable within a short wait. */
async function udpReaches (bound: BoundUdpSocket, host: string, port: number): Promise<boolean> {
  const sender = createSocket({ type: 'udp4' })
  const reader = bound.readable.getReader()
  try {
    sender.send(new Uint8Array([7]), port, host)
    const outcome = await Promise.race([
      reader.read().then((result) => !result.done),
      new Promise<boolean>((resolve) => { setTimeout(() => { resolve(false) }, 400) })
    ])
    return outcome
  } finally {
    reader.releaseLock()
    sender.close()
  }
}

const servers: ListenedServer[] = []
const sockets: BoundUdpSocket[] = []
const raw: DgramSocket[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.destroy('closed')
  for (const socket of sockets.splice(0)) await socket.destroy('closed')
  for (const socket of raw.splice(0)) socket.close()
})

async function listenAt (lo: number, hi: number, scope: BindScope): Promise<ListenedServer> {
  const server = await listenTcp([{ lo, hi }], neverAborts(), scope)
  servers.push(server)
  return server
}

async function bindAt (lo: number, hi: number, scope: BindScope): Promise<BoundUdpSocket> {
  const socket = await bindUdp([{ lo, hi }], neverAborts(), scope)
  sockets.push(socket)
  return socket
}

describe('listenTcp -- the interface follows the scope', () => {
  it('local binds 127.0.0.1, accepts a loopback connection, and refuses one to the LAN address', async () => {
    const server = await listenAt(44100, 44109, 'local')
    expect(server.localAddress).toBe('127.0.0.1')
    expect(await tcpReaches('127.0.0.1', server.localPort)).toBe(true)
    await withLan(async (lan) => { expect(await tcpReaches(lan, server.localPort)).toBe(false) })
  })

  it('network binds every interface and accepts both', async () => {
    const server = await listenAt(44110, 44119, 'network')
    expect(server.localAddress).toBe('0.0.0.0')
    expect(await tcpReaches('127.0.0.1', server.localPort)).toBe(true)
    await withLan(async (lan) => { expect(await tcpReaches(lan, server.localPort)).toBe(true) })
  })

  it('a scope that is neither still binds loopback only: only network widens', async () => {
    const server = await listenAt(44120, 44129, 'anything else' as BindScope)
    expect(server.localAddress).toBe('127.0.0.1')
    await withLan(async (lan) => { expect(await tcpReaches(lan, server.localPort)).toBe(false) })
  })
})

describe('bindUdp -- the interface follows the scope', () => {
  it('local binds 127.0.0.1, receives from loopback, and not from the LAN address', async () => {
    const socket = await bindAt(44200, 44209, 'local')
    expect(socket.localAddress).toBe('127.0.0.1')
    expect(await udpReaches(socket, '127.0.0.1', socket.localPort)).toBe(true)
    await withLan(async (lan) => { expect(await udpReaches(socket, lan, socket.localPort)).toBe(false) })
  })

  it('network binds every interface and receives on both', async () => {
    const socket = await bindAt(44210, 44219, 'network')
    expect(socket.localAddress).toBe('0.0.0.0')
    expect(await udpReaches(socket, '127.0.0.1', socket.localPort)).toBe(true)
    await withLan(async (lan) => { expect(await udpReaches(socket, lan, socket.localPort)).toBe(true) })
  })

  it('a scope that is neither still binds loopback only', async () => {
    const socket = await bindAt(44220, 44229, 'anything else' as BindScope)
    expect(socket.localAddress).toBe('127.0.0.1')
  })
})

describe('through the broker with the real adapters: which grant opens which socket', () => {
  const APP = 'https://app.example'

  function realBroker (): Broker {
    return createBroker({
      dial: async () => { throw new Error('not used by this test') },
      dialSecure: async () => { throw new Error('not used by this test') },
      bind: bindUdp,
      listen: listenTcp,
      resolve: async () => [],
      resolveLookup: async () => [],
      proxyConfigured: async () => false,
      now: () => Date.now(),
      fs: nodeFs('/tmp/orivon-bind-scope-unused'),
      keychain: { getSeed: async () => { throw new Error('not used by this test') } },
      pickPath: async () => { throw new Error('not used by this test') }
    })
  }

  async function brokerHolding (kind: 'tcp.listen' | 'udp.bind', scope: BindScope, ports: string): Promise<Broker> {
    const broker = realBroker()
    const list = { [scope]: [ports] }
    broker.registerApp(APP, {
      orivonApiVersion: 0, id: 'org.orivon.test', name: 'Test', version: '1.0.0', entry: '/index.html',
      capabilities: { net: kind === 'tcp.listen' ? { tcp: { listen: list } } : { udp: { bind: list } } }
    })
    await broker.grant(APP, `${kind}.${scope}`, [ports])
    return broker
  }

  it('a .local-only grant opens a real loopback listener when scope is omitted or local, and is refused network', async () => {
    const broker = await brokerHolding('tcp.listen', 'local', '44300-44309')

    const omitted = await broker.net.listen(APP, { port: 44300 })
    expect(omitted.localAddress).toBe('127.0.0.1')
    expect(await tcpReaches('127.0.0.1', 44300)).toBe(true)
    await withLan(async (lan) => { expect(await tcpReaches(lan, 44300)).toBe(false) })

    const explicit = await broker.net.listen(APP, { port: 44301, scope: 'local' })
    expect(explicit.localAddress).toBe('127.0.0.1')

    await expect(broker.net.listen(APP, { port: 44302, scope: 'network' })).rejects.toMatchObject({ code: 'denied' })
    expect(await tcpReaches('127.0.0.1', 44302)).toBe(false)
    await omitted.close()
    await explicit.close()
  })

  it('a .network grant opens a listener other devices can reach with scope network, and a loopback one with scope local', async () => {
    const broker = await brokerHolding('tcp.listen', 'network', '44310-44319')

    const wide = await broker.net.listen(APP, { port: 44310, scope: 'network' })
    expect(wide.localAddress).toBe('0.0.0.0')
    await withLan(async (lan) => { expect(await tcpReaches(lan, 44310)).toBe(true) })

    const narrow = await broker.net.listen(APP, { port: 44311, scope: 'local' })
    expect(narrow.localAddress).toBe('127.0.0.1')
    await withLan(async (lan) => { expect(await tcpReaches(lan, 44311)).toBe(false) })
    await wide.close()
    await narrow.close()
  })

  it('a .local-only grant opens a real loopback UDP socket, and is refused network', async () => {
    const broker = await brokerHolding('udp.bind', 'local', '44320-44329')

    const socket = await broker.net.udpBind(APP, { port: 44320 })
    expect(socket.localAddress).toBe('127.0.0.1')
    await expect(broker.net.udpBind(APP, { port: 44321, scope: 'network' })).rejects.toMatchObject({ code: 'denied' })
    await socket.close()
  })

  it('a .network grant opens a UDP socket on every interface with scope network', async () => {
    const broker = await brokerHolding('udp.bind', 'network', '44330-44339')

    const socket = await broker.net.udpBind(APP, { port: 44330, scope: 'network' })
    expect(socket.localAddress).toBe('0.0.0.0')
    const narrow = await broker.net.udpBind(APP, { port: 44331 })
    expect(narrow.localAddress).toBe('127.0.0.1')
    await socket.close()
    await narrow.close()
  })
})
