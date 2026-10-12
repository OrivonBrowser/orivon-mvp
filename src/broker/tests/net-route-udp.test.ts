// A routed app's UDP and listening paths at the assembly layer: a datagram to
// this machine goes out of the bound socket and any other through the route,
// named and never resolved here; what comes back is accepted from the route
// only; `local` binds and listens are allowed and `network` ones are denied.

import { describe, expect, it, vi } from 'vitest'
import { rejection } from '../handles/tests/handles.test-helpers.js'
import { APP, baseDeps, okListenedServer, okUdpSocket } from './index.test-helpers.js'
import { createBroker } from '../index.js'
import { datagramTo, fakeUdp, recordedRoute, registerAndGrant, routedBroker } from './net-route.test-helpers.js'
import type { Datagram } from '../../contracts/index.js'
import type { BoundUdpSocket } from '../broker-contracts.js'

const SEND = ['*:*', '127.0.0.1:*', 'localhost:*'] as const
const UDP_CAPS = { net: { udp: { bind: { local: ['40000-40010'] }, send: [...SEND] } } } as const

/** Deps that fail the test if the machine resolves a name or asks T20. */
function noLocalNetwork () {
  return { resolve: vi.fn(async (): Promise<readonly string[]> => { throw new Error('resolved locally') }), proxyConfigured: vi.fn(async () => true) }
}

async function boundSocket (broker: ReturnType<typeof routedBroker>) {
  await registerAndGrant(broker, UDP_CAPS, [['udp.bind.local', ['40000-40010']], ['udp.send', SEND]])
  return await broker.net.udpBind(APP, { port: 40005 })
}

async function readOne<T> (stream: ReadableStream<T>): Promise<T> {
  const { value } = await stream.getReader().read()
  if (value === undefined) throw new Error('stream ended')
  return value
}

describe('udp.send for a routed app', () => {
  it('sends a datagram to this machine out of the bound socket, never through the route', async () => {
    const udp = fakeUdp()
    const { route, udpOpened } = recordedRoute({ udp })
    const rawSend = vi.fn(async () => ({ sent: true } as const))
    const broker = routedBroker(route, { ...noLocalNetwork(), bind: async () => okUdpSocket({ send: rawSend }) })
    const socket = await boundSocket(broker)

    await expect(socket.send(datagramTo('127.0.0.1', 5000))).resolves.toEqual({ sent: true })
    await expect(socket.send(datagramTo('localhost', 5000))).resolves.toEqual({ sent: true })

    expect(rawSend).toHaveBeenCalledTimes(2)
    expect(udpOpened.count).toBe(0)
  })

  it('sends anything else through the route, by the name the app gave, with no local resolve', async () => {
    const udp = fakeUdp()
    const { route, udpOpened } = recordedRoute({ udp })
    const rawSend = vi.fn(async () => ({ sent: true } as const))
    const deps = { ...noLocalNetwork(), bind: async () => okUdpSocket({ send: rawSend }) }
    const broker = routedBroker(route, deps)
    const socket = await boundSocket(broker)

    await expect(socket.send(datagramTo('peer.example', 6881, [7, 8]))).resolves.toEqual({ sent: true })
    await expect(socket.send(datagramTo('93.184.216.34', 4000))).resolves.toEqual({ sent: true })

    expect(udp.sent.map((entry) => `${entry.host}:${String(entry.port)}`)).toEqual(['peer.example:6881', '93.184.216.34:4000'])
    expect([...(udp.sent[0]?.data ?? [])]).toEqual([7, 8])
    expect(udpOpened.count).toBe(1)
    expect(rawSend).not.toHaveBeenCalled()
    expect(deps.resolve).not.toHaveBeenCalled()
    expect(deps.proxyConfigured).not.toHaveBeenCalled()
  })

  it('refuses a destination the grant does not cover, and a private literal under a wildcard', async () => {
    const udp = fakeUdp()
    const { route, udpOpened } = recordedRoute({ udp })
    const broker = routedBroker(route, { ...noLocalNetwork(), bind: async () => okUdpSocket() })
    await registerAndGrant(broker, { net: { udp: { bind: { local: ['40000-40010'] }, send: ['only.example:4000'] } } }, [['udp.bind.local', ['40000-40010']], ['udp.send', ['only.example:4000']]])
    const socket = await broker.net.udpBind(APP, { port: 40005 })

    await expect(socket.send(datagramTo('other.example', 4000))).resolves.toEqual({ sent: false, code: 'denied' })

    const wide = routedBroker(route, { ...noLocalNetwork(), bind: async () => okUdpSocket() })
    const wideSocket = await boundSocket(wide)
    await expect(wideSocket.send(datagramTo('192.168.1.1', 4000))).resolves.toEqual({ sent: false, code: 'denied' })
    expect(udpOpened.count).toBe(0)
  })

  it('is denied, as a value, when the route cannot carry UDP, and still reaches this machine', async () => {
    const { route } = recordedRoute({ udp: null })
    const rawSend = vi.fn(async () => ({ sent: true } as const))
    const broker = routedBroker(route, { ...noLocalNetwork(), bind: async () => okUdpSocket({ send: rawSend }) })
    const socket = await boundSocket(broker)

    await expect(socket.send(datagramTo('peer.example', 6881))).resolves.toEqual({ sent: false, code: 'denied' })
    await expect(socket.send(datagramTo('127.0.0.1', 6881))).resolves.toEqual({ sent: true })
  })

  it('maps a route error to unreachable, as a value, and tries again on the next datagram', async () => {
    let attempts = 0
    const udp = fakeUdp()
    const { route } = recordedRoute({ udp: async () => { attempts += 1; if (attempts === 1) throw new Error('proxy refused ASSOCIATE'); return udp } })
    const broker = routedBroker(route, { ...noLocalNetwork(), bind: async () => okUdpSocket() })
    const socket = await boundSocket(broker)

    await expect(socket.send(datagramTo('peer.example', 1))).resolves.toMatchObject({ sent: false, code: 'unreachable' })
    await expect(socket.send(datagramTo('peer.example', 1))).resolves.toEqual({ sent: true })
  })

  it('maps a failed send on the channel to unreachable', async () => {
    const udp = fakeUdp()
    const failing = { ...udp, send: async () => { throw Object.assign(new Error('gone'), { code: 'ECONNRESET' }) } }
    const { route } = recordedRoute({ udp: failing })
    const broker = routedBroker(route, { ...noLocalNetwork(), bind: async () => okUdpSocket() })
    const socket = await boundSocket(broker)

    await expect(socket.send(datagramTo('peer.example', 1))).resolves.toMatchObject({ sent: false, code: 'unreachable' })
  })

  it('never sends elsewhere than this machine once the route has gone, or when it came after the bind', async () => {
    const udp = fakeUdp()
    const { route } = recordedRoute({ udp })
    let current: typeof route | undefined = route
    const rawSend = vi.fn(async () => ({ sent: true } as const))
    const broker = createBroker(baseDeps({ ...noLocalNetwork(), routeFor: () => current, bind: async () => okUdpSocket({ send: rawSend }) }))
    const socket = await boundSocket(broker)

    current = undefined
    await expect(socket.send(datagramTo('peer.example', 1))).resolves.toEqual({ sent: false, code: 'denied' })

    const unrouted = createBroker(baseDeps({ routeFor: () => current, bind: async () => okUdpSocket({ send: rawSend }), resolve: async () => ['93.184.216.34'] }))
    const later = await boundSocket(unrouted)
    current = route
    await expect(later.send(datagramTo('peer.example', 1))).resolves.toEqual({ sent: false, code: 'denied' })
    expect(udp.sent).toEqual([])
  })

  it('closes the route\'s channel when the socket is closed', async () => {
    const udp = fakeUdp()
    const { route } = recordedRoute({ udp })
    const broker = routedBroker(route, { ...noLocalNetwork(), bind: async () => okUdpSocket() })
    const socket = await boundSocket(broker)
    await socket.send(datagramTo('peer.example', 1))

    await socket.close()

    expect(udp.close).toHaveBeenCalled()
  })

  it('keeps T20 and the direct path for an app with no route', async () => {
    const rawSend = vi.fn(async () => ({ sent: true } as const))
    let proxied = false
    const broker = createBroker(baseDeps({ routeFor: () => undefined, proxyConfigured: async () => proxied, bind: async () => okUdpSocket({ send: rawSend }), resolve: async () => ['93.184.216.34'] }))
    const socket = await boundSocket(broker)

    await expect(socket.send(datagramTo('93.184.216.34', 4000))).resolves.toEqual({ sent: true })
    proxied = true
    await expect(socket.send(datagramTo('93.184.216.34', 4000))).resolves.toEqual({ sent: false, code: 'denied' })
    expect(rawSend).toHaveBeenCalledOnce()
  })
})

describe('inbound datagrams for a routed app', () => {
  function controlled (): { readonly bound: BoundUdpSocket, push: (datagram: Datagram) => void } {
    let controller: ReadableStreamDefaultController<Datagram> | undefined
    const readable = new ReadableStream<Datagram>({ start (c) { controller = c } })
    return { bound: okUdpSocket({ readable }), push: (datagram) => { controller?.enqueue(datagram) } }
  }

  it('delivers what the route sends back, named as the route names it', async () => {
    const udp = fakeUdp()
    const { route } = recordedRoute({ udp })
    const local = controlled()
    const broker = routedBroker(route, { ...noLocalNetwork(), bind: async () => local.bound })
    const socket = await boundSocket(broker)
    await socket.send(datagramTo('peer.example', 6881))

    udp.deliver({ host: 'peer.example', port: 6881, data: new Uint8Array([9]) })

    expect(await readOne(socket.readable)).toEqual({ address: 'peer.example', port: 6881, data: new Uint8Array([9]), family: 'IPv4' })
  })

  it('accepts a datagram from this machine and drops one from anywhere else, counting it', async () => {
    const { route } = recordedRoute({ udp: fakeUdp() })
    const local = controlled()
    const broker = routedBroker(route, { ...noLocalNetwork(), bind: async () => local.bound })
    const socket = await boundSocket(broker)

    local.push(datagramTo('8.8.8.8', 53, [1]))
    local.push(datagramTo('127.0.0.1', 5000, [2]))

    const first = await readOne(socket.readable)
    expect(first.address).toBe('127.0.0.1')
    expect(socket.droppedInbound).toBe(1)
  })
})

describe('listen and udp.bind for a routed app', () => {
  it('allows scope local, asks no T20, and binds loopback', async () => {
    const { route } = recordedRoute()
    const listen = vi.fn(async () => okListenedServer())
    const bind = vi.fn(async () => okUdpSocket())
    const deps = { ...noLocalNetwork(), listen, bind }
    const broker = routedBroker(route, deps)
    await registerAndGrant(broker, { net: { tcp: { listen: { local: ['30000-30010'] } }, udp: { bind: { local: ['40000-40010'] } } } }, [['tcp.listen.local', ['30000-30010']], ['udp.bind.local', ['40000-40010']]])

    const server = await broker.net.listen(APP, { port: 30005 })
    const udp = await broker.net.udpBind(APP, { port: 40005 })

    expect(listen).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'local')
    expect(bind).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'local')
    expect(deps.proxyConfigured).not.toHaveBeenCalled()
    await server.close()
    await udp.close()
  })

  it('denies scope network, with a network grant held, before anything is bound', async () => {
    const { route } = recordedRoute()
    const listen = vi.fn(async () => okListenedServer())
    const bind = vi.fn(async () => okUdpSocket())
    const broker = routedBroker(route, { listen, bind })
    await registerAndGrant(broker, { net: { tcp: { listen: { network: ['30000-30010'] } }, udp: { bind: { network: ['40000-40010'] } } } }, [['tcp.listen.network', ['30000-30010']], ['udp.bind.network', ['40000-40010']]])

    expect((await rejection(broker.net.listen(APP, { port: 30005, scope: 'network' }))).code).toBe('denied')
    expect((await rejection(broker.net.udpBind(APP, { port: 40005, scope: 'network' }))).code).toBe('denied')
    expect(listen).not.toHaveBeenCalled()
    expect(bind).not.toHaveBeenCalled()
  })

  it('leaves an unrouted app\'s network scope and T20 as they were', async () => {
    const listen = vi.fn(async () => okListenedServer())
    const broker = createBroker(baseDeps({ routeFor: () => undefined, listen }))
    await registerAndGrant(broker, { net: { tcp: { listen: { network: ['30000-30010'] } } } }, [['tcp.listen.network', ['30000-30010']]])

    const server = await broker.net.listen(APP, { port: 30005, scope: 'network' })

    expect(listen).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'network')
    await server.close()
  })
})
