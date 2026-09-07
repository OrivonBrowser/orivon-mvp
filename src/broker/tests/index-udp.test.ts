import { describe, expect, it, vi } from 'vitest'
import { rejection } from '../handles/tests/handles.test-helpers.js'
import { APP, baseDeps, manifestWith, okUdpSocket } from './index.test-helpers.js'
import { createBroker } from '../index.js'
import type { Bind, BoundUdpSocket, Broker } from '../broker-contracts.js'
import type { Datagram } from '../../contracts/index.js'

// `orivon.net.udpBind` at the assembly layer -- the same job index.test.ts
// does for connect, and the same single idea: the GRANTED set decides, never
// the manifest's declared one.
//
// Its own file rather than more of index.test.ts, which is at 799 of Rule 2's
// 800 lines for a test.
//
// TWO THINGS HERE HAVE NO TCP COUNTERPART, and they are the reason most of
// this file exists: `udp.bind` and `udp.send` are SEPARATE grants, so a
// socket can be legitimately bound and still authorised to send nowhere; and
// the send check runs PER DATAGRAM against the live grant, because a UDP
// socket has no fixed peer to check once at acquisition.

const DECLARED = { net: { udp: { bind: ['6881-6889'], send: ['*:*'] } } }

function datagram (overrides: Partial<Datagram> = {}): Datagram {
  return { data: new Uint8Array([1]), address: '93.184.216.34', port: 6881, family: 'IPv4', ...overrides }
}

/** A broker with `udp.bind` granted over 6881-6889 and nothing else. */
async function boundBroker (deps = baseDeps()): Promise<Broker> {
  const broker = createBroker(deps)
  broker.registerApp(APP, manifestWith(DECLARED))
  await broker.grant(APP, 'udp.bind', ['6881-6889'])
  return broker
}

describe('udpBind -- the grant ledger decides', () => {
  it('denies when udp.bind was never granted, however broadly the manifest declares it', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith(DECLARED))

    const error = await rejection(broker.net.udpBind(APP, { port: 6881 }))

    expect(error.code).toBe('denied')
    // A denial never says why (contracts/errors.ts) -- a platformCode here
    // would leak whether the port or the grant was the problem.
    expect(error.platformCode).toBeUndefined()
  })

  it('denies a port outside the granted range', async () => {
    const broker = await boundBroker()
    const error = await rejection(broker.net.udpBind(APP, { port: 9999 }))
    expect(error.code).toBe('denied')
  })

  it('binds a port inside the granted range and returns a live handle', async () => {
    // The adapter reports the port it ACTUALLY bound, which is not always the
    // one requested (an ephemeral bind, or a retry past a taken port), so the
    // stub reports a different one than was asked for on purpose: this asserts
    // the broker passes the adapter's answer through rather than echoing back
    // the request.
    const broker = await boundBroker(baseDeps({ bind: async () => okUdpSocket({ localPort: 6887 }) }))
    const socket = await broker.net.udpBind(APP, { port: 6885 })

    expect(socket.id).toEqual(expect.any(String))
    expect(socket.localPort).toBe(6887)
    expect(socket.localAddress).toBe('0.0.0.0')
    expect(typeof socket.close).toBe('function')
  })

  it('hands the adapter the CHECKED range, never the raw port', async () => {
    const bind = vi.fn<Bind>(async () => okUdpSocket())
    const broker = await boundBroker(baseDeps({ bind }))

    await broker.net.udpBind(APP, { port: 6885 })

    // Narrowed to exactly the port that was checked -- see BindAllowed.ranges.
    expect(bind).toHaveBeenCalledWith([{ lo: 6885, hi: 6885 }], expect.anything())
  })

  it('hands the adapter every granted range for an ephemeral bind (A88)', async () => {
    const bind = vi.fn<Bind>(async () => okUdpSocket())
    const broker = await boundBroker(baseDeps({ bind }))

    await broker.net.udpBind(APP, { port: 0 })

    expect(bind).toHaveBeenCalledWith([{ lo: 6881, hi: 6889 }], expect.anything())
  })

  it('tears the socket down rather than leaking it when the grant is revoked mid-bind', async () => {
    const destroy = vi.fn()
    let revoke = (): void => {}
    const bind: Bind = async () => {
      revoke()
      return okUdpSocket({ destroy })
    }
    const broker = await boundBroker(baseDeps({ bind }))
    const [grant] = await broker.app.grants(APP)
    revoke = () => { void broker.revoke(APP, grant!.id) }

    await rejection(broker.net.udpBind(APP, { port: 6881 }))

    expect(destroy).toHaveBeenCalledWith('revoked')
  })
})

describe('udpBind -- droppedInbound stays live', () => {
  // The trap this pins: the adapter exposes droppedInbound as a GETTER, and
  // building the handle with a spread would copy its value once -- zero,
  // forever. An app would read a counter that never moves and conclude it had
  // lost nothing.
  it('reports the adapter\'s current count, not the count at bind time', async () => {
    const counter = { count: 0 }
    const source: BoundUdpSocket = {
      readable: new ReadableStream(),
      send: async () => ({ sent: true }),
      localAddress: '0.0.0.0',
      localPort: 6881,
      get droppedInbound () { return counter.count },
      destroy: vi.fn()
    }
    const broker = await boundBroker(baseDeps({ bind: async () => source }))
    const socket = await broker.net.udpBind(APP, { port: 6881 })

    expect(socket.droppedInbound).toBe(0)
    counter.count = 7
    expect(socket.droppedInbound).toBe(7)
  })
})

describe('udpBind -- every datagram is authorised on the way out', () => {
  it('refuses to send when udp.send was never granted, though the bind succeeded', async () => {
    const send = vi.fn(async () => ({ sent: true as const }))
    const broker = await boundBroker(baseDeps({ bind: async () => okUdpSocket({ send }) }))
    const socket = await broker.net.udpBind(APP, { port: 6881 })

    const outcome = await socket.send(datagram())

    expect(outcome).toEqual({ sent: false, code: 'denied' })
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses a destination outside the granted send patterns', async () => {
    const send = vi.fn(async () => ({ sent: true as const }))
    const broker = await boundBroker(baseDeps({ bind: async () => okUdpSocket({ send }) }))
    await broker.grant(APP, 'udp.send', ['93.184.216.34:6881'])
    const socket = await broker.net.udpBind(APP, { port: 6881 })

    const outcome = await socket.send(datagram({ address: '10.0.0.5' }))

    expect(outcome).toEqual({ sent: false, code: 'denied' })
    expect(send).not.toHaveBeenCalled()
  })

  it('sends to a destination the grant covers', async () => {
    const send = vi.fn(async () => ({ sent: true as const }))
    const broker = await boundBroker(baseDeps({ bind: async () => okUdpSocket({ send }) }))
    await broker.grant(APP, 'udp.send', ['93.184.216.34:6881'])
    const socket = await broker.net.udpBind(APP, { port: 6881 })

    expect(await socket.send(datagram())).toEqual({ sent: true })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ address: '93.184.216.34', port: 6881 }))
  })

  it('sends to the resolved literal, never to the hostname the app named (T12)', async () => {
    const send = vi.fn(async () => ({ sent: true as const }))
    const broker = await boundBroker(baseDeps({
      bind: async () => okUdpSocket({ send }),
      resolve: async () => ['93.184.216.34']
    }))
    await broker.grant(APP, 'udp.send', ['*:*'])
    const socket = await broker.net.udpBind(APP, { port: 6881 })

    await socket.send(datagram({ address: 'peer.example' }))

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ address: '93.184.216.34' }))
  })

  // A70's lesson, applied before it could recur: the grant is re-read per
  // datagram, so a revoke stops the NEXT DATAGRAM, not just the next bind.
  it('stops sending the moment udp.send is revoked, on an already-bound socket', async () => {
    const send = vi.fn(async () => ({ sent: true as const }))
    const broker = await boundBroker(baseDeps({ bind: async () => okUdpSocket({ send }) }))
    const sendGrant = await broker.grant(APP, 'udp.send', ['93.184.216.34:6881'])
    const socket = await broker.net.udpBind(APP, { port: 6881 })

    expect(await socket.send(datagram())).toEqual({ sent: true })
    await broker.revoke(APP, sendGrant.id)

    expect(await socket.send(datagram())).toEqual({ sent: false, code: 'denied' })
    expect(send).toHaveBeenCalledTimes(1)
  })

  // A87: the caller's only way to report a rejection is to error the app's
  // WritableStream, which errors it permanently. Nothing here may reject.
  it('reports a resolver failure as a value rather than rejecting', async () => {
    const broker = await boundBroker(baseDeps({
      bind: async () => okUdpSocket(),
      resolve: async () => { throw Object.assign(new Error('dns down'), { code: 'EAI_AGAIN' }) }
    }))
    await broker.grant(APP, 'udp.send', ['*:*'])
    const socket = await broker.net.udpBind(APP, { port: 6881 })

    const outcome = await socket.send(datagram({ address: 'peer.example' }))

    expect(outcome).toMatchObject({ sent: false, code: 'unreachable' })
  })
})
