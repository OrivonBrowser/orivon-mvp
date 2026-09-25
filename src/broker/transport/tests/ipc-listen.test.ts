import { describe, expect, it, vi } from 'vitest'
import { handleControlRequest } from '../ipc.js'
import type { ControlEvent } from '../ipc.js'
import {
  APP, OTHER, envelope, fakeMultiTransport, fakeTcpServer, frameFor, stubBroker, tick
} from './ipc.test-helpers.js'
import type { BrokerCall } from './ipc.test-helpers.js'
import { PORT_CHANNEL } from '../../../main/channels.js'
import { fail } from '../../errors.js'

// `net.listen` at the IPC layer -- ipc-udp.test.ts's own sibling, and its
// own file for the same reason: a whole control method, kept off ipc.test.ts
// (docs/development/code-guidelines.md's 800-line test limit).
//
// The security properties asserted here are the SAME three net.connect's/
// net.udpBind's own are (the origin comes from the frame, the port goes only
// to that frame, an abandoned delivery releases the handle) -- what is new
// is that the server's OWN port later carries AcceptedMessage traffic, which
// transport/relay/tests/server.test.ts covers; this file is only the control-channel half.

async function listen (
  options: { event?: ControlEvent, port?: number, fake?: ReturnType<typeof fakeTcpServer> } = {}
): Promise<{ calls: BrokerCall[], result: unknown, transport: ReturnType<typeof fakeMultiTransport>, fake: ReturnType<typeof fakeTcpServer> }> {
  const calls: BrokerCall[] = []
  const fake = options.fake ?? fakeTcpServer()
  const broker = stubBroker(calls, { listen: async () => fake.server })
  const transport = fakeMultiTransport()
  const event = options.event ?? frameFor(APP)
  const result = await handleControlRequest(
    broker, event, envelope('net.listen', { port: options.port ?? 4001 }), transport
  )
  await tick()
  return { calls, result, transport, fake }
}

describe('net.listen over the control channel', () => {
  it('attributes the listen to the frame\'s origin, never to a payload', async () => {
    const { calls } = await listen()
    expect(calls).toContainEqual({ method: 'net.listen', origin: APP, args: { port: 4001 } })
  })

  it('returns a descriptor, never the server itself', async () => {
    const { result } = await listen()
    expect(result).toEqual({
      ok: true,
      id: expect.any(String),
      result: { id: 'handle-server-1', localAddress: '0.0.0.0', localPort: 4001 }
    })
  })

  it('carries no connections stream in the descriptor, which cannot survive structured clone', async () => {
    const { result } = await listen()
    const descriptor = (result as { result: Record<string, unknown> }).result
    expect(descriptor).not.toHaveProperty('connections')
  })

  it('delivers the server\'s own port to the calling frame, tagged with the same handle id', async () => {
    const event = frameFor(APP)
    const postMessage = vi.spyOn(event.senderFrame!, 'postMessage')
    await listen({ event })
    expect(postMessage).toHaveBeenCalledWith(PORT_CHANNEL, { handleId: 'handle-server-1' }, [expect.anything()])
  })

  it('rejects a port that is not an integer in range', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {})
    const transport = fakeMultiTransport()
    const result = await handleControlRequest(
      broker, frameFor(APP), envelope('net.listen', { port: 70000 }), transport
    )
    expect(result).toMatchObject({ ok: false, code: 'invalid' })
    expect(calls).toHaveLength(0)
  })

  it('accepts port 0, which means "any free port"', async () => {
    const { calls } = await listen({ port: 0 })
    expect(calls).toContainEqual({ method: 'net.listen', origin: APP, args: { port: 0 } })
  })

  // The out-of-grant / denied path: broker.net.listen itself refuses before
  // any FailableTcpServer ever exists -- this file's own transport plumbing
  // never runs, matching capabilities/net.ts's own `listen()` (no grant, no
  // acquisition).
  it('propagates a denial from broker.net.listen without ever minting a port pair', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      listen: async () => { throw fail('denied', 'tcp.listen is not granted to this origin') }
    })
    const transport = fakeMultiTransport()

    const result = await handleControlRequest(
      broker, frameFor(APP), envelope('net.listen', { port: 4001 }), transport
    )

    expect(result).toMatchObject({ ok: false, code: 'denied' })
    expect(transport.pairs).toHaveLength(0)
  })

  // T17: a MessagePort carries no sender identity, so delivering one across
  // an origin change hands a bearer capability to a page that never asked
  // for it.
  it('abandons the server rather than delivering its port to a frame that changed origin', async () => {
    const fake = fakeTcpServer()
    let origin = APP
    const event: ControlEvent = {
      senderFrame: { url: `${APP}/`, origin: APP, postMessage: vi.fn() } as never
    }
    Object.defineProperty(event.senderFrame!, 'origin', { get: () => origin })
    Object.defineProperty(event.senderFrame!, 'url', { get: () => `${origin}/` })
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, {
      listen: async () => { origin = OTHER; return fake.server }
    })
    const transport = fakeMultiTransport()

    const result = await handleControlRequest(
      broker, event, envelope('net.listen', { port: 4001 }), transport
    )
    await tick()

    expect(result).toMatchObject({ ok: false, code: 'internal' })
    expect(fake.closeSpy).toHaveBeenCalled()
  })
})

describe('the TCP-socket-only options against a TcpServer handle', () => {
  async function optionOn (method: 'net.setNoDelay' | 'net.setKeepAlive'): Promise<unknown> {
    const calls: BrokerCall[] = []
    const fake = fakeTcpServer()
    const broker = stubBroker(calls, { listen: async () => fake.server })
    const transport = fakeMultiTransport()
    await handleControlRequest(broker, frameFor(APP), envelope('net.listen', { port: 4001 }), transport)
    await tick()
    return await handleControlRequest(
      broker, frameFor(APP), envelope(method, { id: 'handle-server-1', on: true }), transport
    )
  }

  it('refuses setNoDelay', async () => {
    expect(await optionOn('net.setNoDelay')).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('refuses setKeepAlive', async () => {
    expect(await optionOn('net.setKeepAlive')).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('still closes through net.close, which every kind answers', async () => {
    const calls: BrokerCall[] = []
    const fake = fakeTcpServer()
    const broker = stubBroker(calls, { listen: async () => fake.server })
    const transport = fakeMultiTransport()
    await handleControlRequest(broker, frameFor(APP), envelope('net.listen', { port: 4001 }), transport)
    await tick()

    const result = await handleControlRequest(
      broker, frameFor(APP), envelope('net.close', { id: 'handle-server-1' }), transport
    )

    expect(result).toMatchObject({ ok: true })
    expect(fake.closeSpy).toHaveBeenCalled()
  })

  // T11c: a handle id from one origin means nothing presented by another.
  it('is a silent no-op when another origin presents the same id', async () => {
    const calls: BrokerCall[] = []
    const fake = fakeTcpServer()
    const broker = stubBroker(calls, { listen: async () => fake.server })
    const transport = fakeMultiTransport()
    await handleControlRequest(broker, frameFor(APP), envelope('net.listen', { port: 4001 }), transport)
    await tick()

    const result = await handleControlRequest(
      broker, frameFor(OTHER), envelope('net.close', { id: 'handle-server-1' }), transport
    )

    expect(result).toMatchObject({ ok: true })
    expect(fake.closeSpy).not.toHaveBeenCalled()
  })
})
