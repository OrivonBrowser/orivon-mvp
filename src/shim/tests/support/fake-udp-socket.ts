// A fake UdpSocket (src/contracts/handles.ts) for exercising
// node-dgram-socket.ts without a broker -- the dgram counterpart of
// fake-tcp-socket.ts. Under tests/support/, not tests/, for the same reason
// that file is: vitest.config.ts's `include` only matches `*.test.ts`.

import type { Datagram, SendRefusal, UdpSocket } from '../../../contracts/handles.js'

export interface FakeUdpSocket {
  readonly socket: UdpSocket
  /** Every datagram written via `socket.writable`, in write order. */
  readonly sent: Datagram[]
  /** Simulates an inbound datagram arriving from the network. */
  deliver (datagram: Datagram): void
  closed (): boolean
}

export function createFakeUdpSocket (opts: { localAddress?: string, localPort?: number } = {}): FakeUdpSocket {
  let readableController!: ReadableStreamDefaultController<Datagram>
  const readable = new ReadableStream<Datagram>({
    start (controller) { readableController = controller }
  })

  const sent: Datagram[] = []
  const writable = new WritableStream<Datagram>({
    write (datagram) { sent.push(datagram) }
  })

  const refusals = new ReadableStream<SendRefusal>({ start () {} })

  let didClose = false
  const socket: UdpSocket = {
    id: 'fake-udp-socket',
    closed: new Promise(() => {}),
    close: async () => { didClose = true },
    readable,
    writable,
    localAddress: opts.localAddress ?? '0.0.0.0',
    localPort: opts.localPort ?? 12345,
    droppedInbound: 0,
    droppedOutbound: 0,
    refusals
  }

  return {
    socket,
    sent,
    deliver: (datagram) => readableController.enqueue(datagram),
    closed: () => didClose
  }
}
