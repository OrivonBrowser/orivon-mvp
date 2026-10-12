import { describe, expect, it, vi } from 'vitest'
import type { Datagram, LookupAddress } from '../../../contracts/index.js'
import type { Bind, Dial, DialedSocket, Listen } from '../../../broker/broker-contracts.js'
import { DNS_PORT, MAX_ANSWERS, MAX_LISTENERS, MAX_SOCKETS, createNodeNet } from '../node-net.js'
import type { NodeNetDeps } from '../node-net.js'

const API_PORT = 24_242

function fakeSocket (): DialedSocket & { destroyed: string[] } {
  const destroyed: string[] = []
  return {
    readable: new ReadableStream<Uint8Array>({ start () {} }),
    writable: new WritableStream<Uint8Array>(),
    remoteAddress: '1.1.1.1',
    remotePort: 1,
    localAddress: '10.0.0.2',
    localPort: 2,
    setNoDelay: async () => {},
    setKeepAlive: async () => {},
    destroy: async (reason) => { destroyed.push(reason) },
    destroyed
  }
}

interface Harness {
  readonly net: ReturnType<typeof createNodeNet>
  readonly dials: Array<{ addresses: readonly string[], port: number }>
  readonly listens: Array<{ ranges: unknown, scope: string }>
  readonly binds: Array<{ ranges: unknown, scope: string }>
  readonly sent: Datagram[]
  readonly lookups: string[]
}

function harness (answers: Record<string, readonly string[]> = {}, overrides: Partial<NodeNetDeps> = {}): Harness {
  const dials: Harness['dials'] = []
  const listens: Harness['listens'] = []
  const binds: Harness['binds'] = []
  const sent: Datagram[] = []
  const lookups: string[] = []
  const dial: Dial = async (addresses, port) => { dials.push({ addresses, port }); return fakeSocket() }
  const listen: Listen = async (ranges, _signal, scope) => {
    listens.push({ ranges, scope })
    return { localAddress: '127.0.0.1', localPort: API_PORT, accept: async () => await new Promise(() => {}), destroy: async () => {} }
  }
  const bind: Bind = async (ranges, _signal, scope) => {
    binds.push({ ranges, scope })
    return {
      readable: new ReadableStream<Datagram>({ start () {} }),
      send: async (datagram) => { sent.push(datagram); return { sent: true } },
      localAddress: '0.0.0.0',
      localPort: 40_000,
      droppedInbound: 0,
      destroy: async () => {}
    }
  }
  const lookup = async (hostname: string): Promise<readonly LookupAddress[]> => {
    lookups.push(hostname)
    const found = answers[hostname]
    if (found === undefined) throw Object.assign(new Error('no such name'), { code: 'unreachable' })
    return found.map((address) => ({ address, family: address.includes(':') ? 'IPv6' as const : 'IPv4' as const }))
  }
  return { net: createNodeNet(API_PORT, { dial, listen, bind, lookup, ...overrides }), dials, listens, binds, sent, lookups }
}

describe('connect', () => {
  it('dials a public address literal as the canonical literal', async () => {
    const { net, dials } = harness()
    await net.connect({ host: '8.8.8.8', port: 1634 })
    expect(dials).toEqual([{ addresses: ['8.8.8.8'], port: 1634 }])
  })

  it.each([
    ['loopback', '127.0.0.1'], ['loopback v6', '::1'], ['private 10/8', '10.1.2.3'], ['private 192.168/16', '192.168.1.1'],
    ['private 172.16/12', '172.16.0.9'], ['link-local', '169.254.169.254'], ['unspecified', '0.0.0.0'], ['multicast', '224.0.0.1'],
    ['broadcast', '255.255.255.255'], ['unique-local v6', 'fd00::1'], ['link-local v6', 'fe80::1'], ['v4-mapped loopback', '::ffff:127.0.0.1'],
    ['carrier-grade NAT', '100.64.0.1'], ['bracketed loopback', '[::1]'], ['zone id', 'fe80::1%eth0']
  ])('refuses %s (%s) without dialling', async (_label, host) => {
    const { net, dials, lookups } = harness({ [host]: ['8.8.8.8'] })
    await expect(net.connect({ host, port: 1634 })).rejects.toMatchObject({ code: 'denied' })
    expect(dials).toEqual([])
    expect(lookups).toEqual([])
  })

  it('resolves a name once and dials the checked literals, never the name', async () => {
    const { net, dials, lookups } = harness({ 'peer.example': ['8.8.4.4', '2606:4700:4700::1111'] })
    await net.connect({ host: 'peer.example', port: 1634 })
    expect(lookups).toEqual(['peer.example'])
    expect(dials).toEqual([{ addresses: ['8.8.4.4', '2606:4700:4700::1111'], port: 1634 }])
  })

  it('refuses a name whose answers mix public and private addresses, whole', async () => {
    const { net, dials } = harness({ 'mixed.example': ['8.8.8.8', '10.0.0.5'] })
    await expect(net.connect({ host: 'mixed.example', port: 1634 })).rejects.toMatchObject({ code: 'denied' })
    expect(dials).toEqual([])
  })

  it.each([['localhost', ['127.0.0.1']], ['rebind.example', ['::1']], ['meta.example', ['169.254.169.254']]])('refuses the name %s that resolves to a non-public address', async (host, answers) => {
    const { net, dials } = harness({ [host]: answers })
    await expect(net.connect({ host, port: 80 })).rejects.toMatchObject({ code: 'denied' })
    expect(dials).toEqual([])
  })

  it('refuses a name that resolves to nothing, or that does not resolve', async () => {
    const { net } = harness({ 'empty.example': [] })
    await expect(net.connect({ host: 'empty.example', port: 80 })).rejects.toMatchObject({ code: 'unreachable' })
    await expect(net.connect({ host: 'nowhere.example', port: 80 })).rejects.toMatchObject({ code: 'unreachable' })
  })

  it.each([0, -1, 65_536, 1.5, Number.NaN])('refuses port %s', async (port) => {
    const { net, dials } = harness()
    await expect(net.connect({ host: '8.8.8.8', port })).rejects.toMatchObject({ code: 'invalid' })
    expect(dials).toEqual([])
  })

  it('looks at no more than 64 answers of a name', async () => {
    const many = Array.from({ length: MAX_ANSWERS + 6 }, (_, index) => `8.8.${String(index >> 8)}.${String(index & 255)}`)
    const { net, dials } = harness({ 'many.example': [...many.slice(0, MAX_ANSWERS), '10.0.0.1'] })
    await net.connect({ host: 'many.example', port: 80 })
    expect(dials[0]?.addresses).toHaveLength(MAX_ANSWERS)
  })

  it('holds at most 300 sockets, and a closed one frees its place', async () => {
    const { net } = harness()
    const open = []
    for (let index = 0; index < MAX_SOCKETS; index++) open.push(await net.connect({ host: '8.8.8.8', port: 80 }))
    await expect(net.connect({ host: '8.8.8.8', port: 80 })).rejects.toMatchObject({ code: 'limit' })
    await open[0]?.close()
    await expect(net.connect({ host: '8.8.8.8', port: 80 })).resolves.toBeDefined()
  })

  it('gives a place back when the dial fails', async () => {
    let fail = true
    const dial: Dial = async () => { if (fail) throw new Error('refused'); return fakeSocket() }
    const { net } = harness({}, { dial })
    for (let index = 0; index < MAX_SOCKETS + 5; index++) await expect(net.connect({ host: '8.8.8.8', port: 80 })).rejects.toThrow('refused')
    fail = false
    await expect(net.connect({ host: '8.8.8.8', port: 80 })).resolves.toBeDefined()
  })

  it('frees a place once both directions have ended, without a close call', async () => {
    const socket = fakeSocket()
    const reads = new ReadableStream<Uint8Array>({ start (controller) { controller.close() } })
    const dial: Dial = async () => ({ ...socket, readable: reads, writable: new WritableStream<Uint8Array>() })
    const { net } = harness({}, { dial })
    const handle = await net.connect({ host: '8.8.8.8', port: 80 })
    await handle.readable.getReader().read()
    await handle.writable.getWriter().close()
    await handle.closed
  })
})

describe('listen', () => {
  it('listens on loopback for its API port', async () => {
    const { net, listens } = harness()
    await net.listen({ port: API_PORT, scope: 'local' })
    await net.listen({ port: API_PORT })
    expect(listens.map((entry) => entry.scope)).toEqual(['local', 'local'])
  })

  it('listens on loopback for a port the system picks, which is where a network listen ends up', async () => {
    const { net, listens } = harness()
    await net.listen({ port: 0, scope: 'local' })
    expect(listens).toEqual([{ ranges: [{ lo: 0, hi: 0 }], scope: 'local' }])
  })

  it('refuses the network scope, so the WASI host asks again as local', async () => {
    const { net, listens } = harness()
    await expect(net.listen({ port: 0, scope: 'network' })).rejects.toMatchObject({ code: 'denied' })
    await expect(net.listen({ port: API_PORT, scope: 'network' })).rejects.toMatchObject({ code: 'denied' })
    expect(listens).toEqual([])
  })

  it.each([22, 80, 1634, 8080, API_PORT + 1])('refuses port %s', async (port) => {
    const { net, listens } = harness()
    await expect(net.listen({ port, scope: 'local' })).rejects.toMatchObject({ code: 'denied' })
    expect(listens).toEqual([])
  })

  it('holds at most four listeners, and a closed one frees its place', async () => {
    const { net } = harness()
    const held = []
    for (let index = 0; index < MAX_LISTENERS; index++) held.push(await net.listen({ port: 0, scope: 'local' }))
    await expect(net.listen({ port: 0, scope: 'local' })).rejects.toMatchObject({ code: 'limit' })
    await held[0]?.close()
    await expect(net.listen({ port: 0, scope: 'local' })).resolves.toBeDefined()
  })

  it('hands out an accepted connection as a socket', async () => {
    const queue = [fakeSocket(), fakeSocket()]
    const listen: Listen = async () => ({
      localAddress: '127.0.0.1',
      localPort: API_PORT,
      accept: async () => queue.shift() ?? await new Promise<null>(() => {}),
      destroy: async () => {}
    })
    const { net } = harness({}, { listen })
    const server = await net.listen({ port: API_PORT, scope: 'local' })
    const reader = server.connections.getReader()
    const first = await reader.read()
    expect(first.value?.id).toMatch(/^swarm-node-tcp-/)
  })

  it('resets an accepted connection beyond the socket limit', async () => {
    const accepted = fakeSocket()
    const queue = [accepted]
    const listen: Listen = async () => ({
      localAddress: '127.0.0.1',
      localPort: API_PORT,
      accept: async () => queue.shift() ?? await new Promise<null>(() => {}),
      destroy: async () => {}
    })
    const { net } = harness({}, { listen })
    const server = await net.listen({ port: API_PORT, scope: 'local' })
    for (let index = 0; index < MAX_SOCKETS; index++) await net.udpBind({ port: 0 })
    void server.connections.getReader().read()
    await vi.waitFor(() => { expect(accepted.destroyed).toEqual(['aborted']) })
  })
})

describe('udpBind', () => {
  it('binds an ephemeral port, on every interface or on loopback as asked', async () => {
    const { net, binds } = harness()
    await net.udpBind({ port: 0, scope: 'network' })
    await net.udpBind({ port: 0 })
    expect(binds.map((entry) => entry.scope)).toEqual(['network', 'local'])
    expect(binds[0]?.ranges).toEqual([{ lo: 0, hi: 0 }])
  })

  it('refuses a fixed port', async () => {
    const { net, binds } = harness()
    await expect(net.udpBind({ port: 5353, scope: 'network' })).rejects.toMatchObject({ code: 'denied' })
    expect(binds).toEqual([])
  })

  async function sendThrough (datagram: Partial<Datagram> & Pick<Datagram, 'address' | 'port'>): Promise<{ sent: Datagram[], dropped: number, refusals: unknown[] }> {
    const { net, sent } = harness()
    const socket = await net.udpBind({ port: 0, scope: 'network' })
    const writer = socket.writable.getWriter()
    await writer.write({ data: new Uint8Array([1, 2, 3]), family: 'IPv4', ...datagram })
    const reader = socket.refusals.getReader()
    const refusals: unknown[] = []
    if (socket.droppedOutbound > 0) refusals.push((await reader.read()).value)
    return { sent, dropped: socket.droppedOutbound, refusals }
  }

  it('sends a datagram to a public address on port 53', async () => {
    const result = await sendThrough({ address: '1.1.1.1', port: DNS_PORT })
    expect(result.sent).toHaveLength(1)
    expect(result.dropped).toBe(0)
  })

  it.each([
    ['a private address', '192.168.0.1', 53], ['loopback', '127.0.0.1', 53], ['link-local', '169.254.1.1', 53], ['multicast', '224.0.0.251', 53],
    ['a name', 'resolver.example', 53], ['another port', '1.1.1.1', 123], ['port 5353', '8.8.8.8', 5353]
  ])('drops a datagram to %s, counts it, and names it in refusals', async (_label, address, port) => {
    const result = await sendThrough({ address, port })
    expect(result.sent).toEqual([])
    expect(result.dropped).toBe(1)
    expect(result.refusals).toEqual([{ address, port, code: 'denied' }])
  })

  it('counts a datagram the socket could not send', async () => {
    const bind: Bind = async () => ({
      readable: new ReadableStream<Datagram>(), send: async () => ({ sent: false, code: 'unreachable' }), localAddress: '0.0.0.0', localPort: 1, droppedInbound: 0, destroy: async () => {}
    })
    const { net } = harness({}, { bind })
    const socket = await net.udpBind({ port: 0 })
    await socket.writable.getWriter().write({ data: new Uint8Array(1), address: '1.1.1.1', port: 53, family: 'IPv4' })
    expect(socket.droppedOutbound).toBe(1)
  })

  it('shares the socket limit with TCP', async () => {
    const { net } = harness()
    for (let index = 0; index < MAX_SOCKETS; index++) await net.udpBind({ port: 0 })
    await expect(net.connect({ host: '8.8.8.8', port: 80 })).rejects.toMatchObject({ code: 'limit' })
  })
})

describe('lookup', () => {
  it('answers with no more than 64 addresses', async () => {
    const many = Array.from({ length: 100 }, (_, index) => `8.8.8.${String(index)}`)
    const { net } = harness({ 'big.example': many })
    expect(await net.lookup({ hostname: 'big.example' })).toHaveLength(MAX_ANSWERS)
  })

  it('passes a failure through', async () => {
    const { net } = harness()
    await expect(net.lookup({ hostname: 'gone.example' })).rejects.toBeDefined()
  })
})
