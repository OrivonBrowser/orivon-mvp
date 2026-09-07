import { describe, expect, it, vi } from 'vitest'
import { handleControlRequest } from '../ipc.js'
import type { ControlEvent } from '../ipc.js'
import {
  APP, OTHER, envelope, fakePortPair, fakeTransport, fakeUdpSocket, frameFor, stubBroker, tick
} from './ipc.test-helpers.js'
import type { BrokerCall } from './ipc.test-helpers.js'
import { PORT_CHANNEL } from '../../../main/channels.js'
import type { Datagram } from '../../../contracts/index.js'

// `net.udpBind` at the IPC layer -- its own file because ipc.test.ts is at 653
// of Rule 2's 800 lines for a test and this is a whole control method.
//
// The security properties asserted here are the SAME three net.connect's are
// (the origin comes from the frame, the port goes only to that frame, an
// abandoned delivery releases the socket); what is new is the two TCP-only
// options refusing a UDP handle.

function udpSource (datagrams: Datagram[] = []): ReadableStream<Datagram> {
  return new ReadableStream<Datagram>({
    start (controller) {
      for (const d of datagrams) controller.enqueue(d)
      controller.close()
    }
  })
}

async function bind (
  options: { event?: ControlEvent, port?: number, socket?: ReturnType<typeof fakeUdpSocket> } = {}
): Promise<{ calls: BrokerCall[], result: unknown, port1: ReturnType<typeof fakePortPair>['port1'], fake: ReturnType<typeof fakeUdpSocket> }> {
  const calls: BrokerCall[] = []
  const fake = options.socket ?? fakeUdpSocket(udpSource())
  const broker = stubBroker(calls, { udpBind: async () => fake.socket })
  const { pair, port1 } = fakePortPair()
  const event = options.event ?? frameFor(APP)
  const result = await handleControlRequest(
    broker, event, envelope('net.udpBind', { port: options.port ?? 6881 }), fakeTransport(pair)
  )
  await tick()
  return { calls, result, port1, fake }
}

describe('net.udpBind over the control channel', () => {
  it('attributes the bind to the frame\'s origin, never to a payload', async () => {
    const { calls } = await bind()
    expect(calls).toContainEqual({ method: 'net.udpBind', origin: APP, args: { port: 6881 } })
  })

  it('returns a descriptor, never the socket itself', async () => {
    const { result } = await bind()
    expect(result).toEqual({
      ok: true,
      id: expect.any(String),
      result: { id: 'handle-udp-1', localAddress: '0.0.0.0', localPort: 6881 }
    })
  })

  it('carries no live counter in the descriptor, which would be frozen at zero', async () => {
    const { result } = await bind()
    const descriptor = (result as { result: Record<string, unknown> }).result
    expect(descriptor).not.toHaveProperty('droppedInbound')
    expect(descriptor).not.toHaveProperty('droppedOutbound')
  })

  it('delivers the port to the calling frame, tagged with the same handle id', async () => {
    const event = frameFor(APP)
    const postMessage = vi.spyOn(event.senderFrame!, 'postMessage')
    await bind({ event })
    expect(postMessage).toHaveBeenCalledWith(PORT_CHANNEL, { handleId: 'handle-udp-1' }, [expect.anything()])
  })

  it('rejects a port that is not an integer in range', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {})
    const { pair } = fakePortPair()
    const result = await handleControlRequest(
      broker, frameFor(APP), envelope('net.udpBind', { port: 70000 }), fakeTransport(pair)
    )
    expect(result).toMatchObject({ ok: false, code: 'invalid' })
    expect(calls).toHaveLength(0)
  })

  it('accepts port 0, which means "any free port"', async () => {
    const { calls } = await bind({ port: 0 })
    expect(calls).toContainEqual({ method: 'net.udpBind', origin: APP, args: { port: 0 } })
  })

  // T17: a MessagePort carries no sender identity, so delivering one across an
  // origin change hands a bearer capability to a page that never asked for it.
  it('abandons the socket rather than delivering its port to a frame that changed origin', async () => {
    const fake = fakeUdpSocket(udpSource())
    let origin = APP
    const event: ControlEvent = {
      senderFrame: { url: `${APP}/`, origin: APP, postMessage: vi.fn() } as never
    }
    Object.defineProperty(event.senderFrame!, 'origin', { get: () => origin })
    Object.defineProperty(event.senderFrame!, 'url', { get: () => `${origin}/` })
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      udpBind: async () => { origin = OTHER; return fake.socket }
    })
    const { pair } = fakePortPair()

    const result = await handleControlRequest(
      broker, event, envelope('net.udpBind', { port: 6881 }), fakeTransport(pair)
    )
    await tick()

    expect(result).toMatchObject({ ok: false, code: 'internal' })
    expect(fake.closeSpy).toHaveBeenCalled()
  })
})

describe('the TCP-only socket options against a UDP handle', () => {
  async function optionOn (method: 'net.setNoDelay' | 'net.setKeepAlive'): Promise<unknown> {
    const calls: BrokerCall[] = []
    const fake = fakeUdpSocket(udpSource())
    const broker = stubBroker(calls, { udpBind: async () => fake.socket })
    const { pair } = fakePortPair()
    const transport = fakeTransport(pair)
    await handleControlRequest(broker, frameFor(APP), envelope('net.udpBind', { port: 6881 }), transport)
    await tick()
    return await handleControlRequest(
      broker, frameFor(APP), envelope(method, { id: 'handle-udp-1', on: true }), transport
    )
  }

  // 'invalid', not the silent no-op an unknown id gets: the app HOLDS this
  // handle, so this is its own bug rather than a probe, and saying so leaks
  // nothing it did not already know.
  it('refuses setNoDelay', async () => {
    expect(await optionOn('net.setNoDelay')).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('refuses setKeepAlive', async () => {
    expect(await optionOn('net.setKeepAlive')).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('still closes through net.close, which every kind answers', async () => {
    const calls: BrokerCall[] = []
    const fake = fakeUdpSocket(udpSource())
    const broker = stubBroker(calls, { udpBind: async () => fake.socket })
    const { pair } = fakePortPair()
    const transport = fakeTransport(pair)
    await handleControlRequest(broker, frameFor(APP), envelope('net.udpBind', { port: 6881 }), transport)
    await tick()

    const result = await handleControlRequest(
      broker, frameFor(APP), envelope('net.close', { id: 'handle-udp-1' }), transport
    )

    expect(result).toMatchObject({ ok: true })
    expect(fake.closeSpy).toHaveBeenCalled()
  })

  // T11c: a handle id from one origin means nothing presented by another.
  it('is a silent no-op when another origin presents the same id', async () => {
    const calls: BrokerCall[] = []
    const fake = fakeUdpSocket(udpSource())
    const broker = stubBroker(calls, { udpBind: async () => fake.socket })
    const { pair } = fakePortPair()
    const transport = fakeTransport(pair)
    await handleControlRequest(broker, frameFor(APP), envelope('net.udpBind', { port: 6881 }), transport)
    await tick()

    const result = await handleControlRequest(
      broker, frameFor(OTHER), envelope('net.close', { id: 'handle-udp-1' }), transport
    )

    expect(result).toMatchObject({ ok: true })
    expect(fake.closeSpy).not.toHaveBeenCalled()
  })
})
