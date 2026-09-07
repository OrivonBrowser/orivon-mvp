import { describe, expect, it, vi } from 'vitest'
import { createDatagramRelay } from '../datagram-relay.js'
import { createPortRegistry } from '../port-registry.js'
import type { RegisteredSocket } from '../port-transport.js'
import { fakePort, fakeUdpSocket, tick } from './ipc.test-helpers.js'
import type { Datagram } from '../../../contracts/index.js'

// The wiring that owns one UDP socket's port. socket-relay.test.ts's
// counterpart, and the file where the ONE deliberate asymmetry between them is
// pinned: this relay tears down on every close reason, where the TCP one must
// not, because cancelling a Duplex.toWeb's read half drops its write queue and
// a UDP socket has no write queue to drop.

const APP = 'https://app.example'

function pendingSource (): { readable: ReadableStream<Datagram>, push: (d: Datagram) => void } {
  let controller!: ReadableStreamDefaultController<Datagram>
  return {
    readable: new ReadableStream<Datagram>({ start (c) { controller = c } }),
    push: (d) => { controller.enqueue(d) }
  }
}

function relayHarness (send: Parameters<typeof fakeUdpSocket>[1] = async () => ({ sent: true })): {
  registry: ReturnType<typeof createPortRegistry<RegisteredSocket>>
  port: ReturnType<typeof fakePort>
  fake: ReturnType<typeof fakeUdpSocket>
  relay: ReturnType<typeof createDatagramRelay>
  push: (d: Datagram) => void
} {
  const registry = createPortRegistry<RegisteredSocket>()
  const port = fakePort()
  const source = pendingSource()
  const fake = fakeUdpSocket(source.readable, send)
  const relay = createDatagramRelay({
    origin: APP,
    socket: fake.socket,
    port,
    registry,
    inboundWindow: 8,
    inboundWindowBytes: 4096,
    outboundWindow: 4
  })
  return { registry, port, fake, relay, push: source.push }
}

function datagram (): Datagram {
  return { data: new Uint8Array([1]), address: '93.184.216.34', port: 6881, family: 'IPv4' }
}

describe('createDatagramRelay -- the registry slot', () => {
  it('registers the socket as a udp kind, so the TCP-only options can refuse it', () => {
    const { registry, fake } = relayHarness()
    expect(registry.get(APP, fake.socket.id)?.kind).toBe('udp')
  })

  it('releases the slot and closes the port on cleanup', () => {
    const { registry, port, fake, relay } = relayHarness()
    relay.cleanup()
    expect(registry.get(APP, fake.socket.id)).toBeUndefined()
    expect(port.isClosed()).toBe(true)
  })

  it('is idempotent, so the abandon path and closed settling can both call it', () => {
    const { relay, port } = relayHarness()
    relay.cleanup()
    relay.stop()
    expect(port.isClosed()).toBe(true)
  })
})

describe('createDatagramRelay -- teardown fires on every close reason', () => {
  // THE ASYMMETRY WITH socket-relay.ts, asserted rather than described. There,
  // acting at unlink on a FLUSHING reason truncates the app's queued writes
  // (8 MiB measured lost). Here there is no write queue: a datagram is handed
  // to the OS or refused, never buffered, so waiting would only delay the
  // release of the registry slot and the port.
  for (const reason of ['closed', 'sessionEnded', 'revoked', 'aborted', 'failed'] as const) {
    it(`releases the registry slot at unlink for '${reason}'`, () => {
      const { registry, fake } = relayHarness()
      fake.unlink(reason)
      expect(registry.get(APP, fake.socket.id)).toBeUndefined()
    })
  }

  it('releases when the renderer closes its side of the port', () => {
    const { registry, port, fake } = relayHarness()
    port.simulateClose()
    expect(registry.get(APP, fake.socket.id)).toBeUndefined()
  })

  it('releases when the socket closes on its own', async () => {
    const { registry, fake } = relayHarness()
    fake.settleClosed()
    await tick()
    expect(registry.get(APP, fake.socket.id)).toBeUndefined()
  })
})

describe('createDatagramRelay -- routing messages off the port', () => {
  it('sends a datagram the renderer posted', async () => {
    const send = vi.fn(async () => ({ sent: true as const }))
    const { port } = relayHarness(send)

    port.emit({ kind: 'send', handleId: 'handle-udp-1', data: new Uint8Array([9]), address: '93.184.216.34', port: 6881 })
    await tick()

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ address: '93.184.216.34', port: 6881 }))
  })

  it('ignores a byte-path message posted onto a datagram port', async () => {
    const send = vi.fn(async () => ({ sent: true as const }))
    const { port } = relayHarness(send)

    port.emit({ kind: 'write', handleId: 'handle-udp-1', chunk: new Uint8Array([9]) })
    await tick()

    expect(send).not.toHaveBeenCalled()
  })

  it('ignores a message that matches no known shape', async () => {
    const send = vi.fn(async () => ({ sent: true as const }))
    const { port } = relayHarness(send)

    port.emit({ kind: 'send', handleId: 'handle-udp-1', data: 'not bytes', address: 'x', port: 1 })
    await tick()

    expect(send).not.toHaveBeenCalled()
  })

  it('forwards an inbound datagram to the port', async () => {
    const { port, push } = relayHarness()
    push(datagram())
    await tick()

    expect(port.sent).toContainEqual(expect.objectContaining({
      kind: 'datagram', handleId: 'handle-udp-1', address: '93.184.216.34', port: 6881
    }))
  })

  it('does not forward a datagram that was already queued when the socket was unlinked', async () => {
    // Queued BEFORE the unlink, so the read is already pending: this is the
    // window where a datagram could otherwise reach a page whose grant has
    // just been withdrawn. (Pushing AFTER the unlink is not expressible --
    // teardown cancels the reader, which closes the stream.)
    const { port, push, fake } = relayHarness()
    push(datagram())
    fake.unlink('revoked')
    await tick()

    expect(port.sent.filter((m) => (m as { kind?: string }).kind === 'datagram')).toHaveLength(0)
  })
})
