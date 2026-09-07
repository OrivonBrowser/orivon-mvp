import { describe, expect, it, vi } from 'vitest'
import { createDatagramPump } from '../datagram-pump.js'
import type { BrokerToRendererMessage, Datagram } from '../../../contracts/index.js'

// The inbound half of the datagram relay. Pure and Electron-free like
// ../port-pump.ts, which is what lets these run under plain vitest with a
// hand-built ReadableStream and no MessagePortMain.

function datagram (byteLength = 4, address = '93.184.216.34'): Datagram {
  return { data: new Uint8Array(byteLength), address, port: 6881, family: 'IPv4' }
}

/** A readable the test pushes into by hand, so credit behaviour is observable. */
function manualReadable (): {
  readable: ReadableStream<Datagram>
  push: (d: Datagram) => void
  close: () => void
  error: (e: unknown) => void
} {
  let controller!: ReadableStreamDefaultController<Datagram>
  const readable = new ReadableStream<Datagram>({ start (c) { controller = c } })
  return {
    readable,
    push: (d) => { controller.enqueue(d) },
    close: () => { controller.close() },
    error: (e) => { controller.error(e) }
  }
}

const settle = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)) }

describe('createDatagramPump', () => {
  it('posts each datagram whole, with its source address and port', async () => {
    const sent: BrokerToRendererMessage[] = []
    const source = manualReadable()
    createDatagramPump({
      handleId: 'h1',
      readable: source.readable,
      send: (m) => { sent.push(m) },
      initialCredit: 8,
      initialCreditBytes: 4096,
      droppedInbound: () => 0
    })

    source.push(datagram(4, '10.0.0.9'))
    await settle()

    expect(sent).toEqual([expect.objectContaining({
      kind: 'datagram', handleId: 'h1', address: '10.0.0.9', port: 6881, family: 'IPv4'
    })])
  })

  it('stops reading once the count window is exhausted', async () => {
    const sent: BrokerToRendererMessage[] = []
    const source = manualReadable()
    createDatagramPump({
      handleId: 'h1',
      readable: source.readable,
      send: (m) => { sent.push(m) },
      initialCredit: 2,
      initialCreditBytes: 1_000_000,
      droppedInbound: () => 0
    })

    for (let i = 0; i < 5; i += 1) source.push(datagram())
    await settle()

    expect(sent).toHaveLength(2)
  })

  it('stops reading once the byte window is exhausted, even with count to spare', async () => {
    // OVERSHOOTS BY AT MOST ONE DATAGRAM, deliberately: the size is only known
    // after the read, so the window is checked before reading and the datagram
    // that crosses it is still delivered. Same property a ReadableStream's own
    // high-water mark has. The assertion pins the real behaviour rather than
    // the tidier one.
    const sent: BrokerToRendererMessage[] = []
    const source = manualReadable()
    createDatagramPump({
      handleId: 'h1',
      readable: source.readable,
      send: (m) => { sent.push(m) },
      initialCredit: 100,
      initialCreditBytes: 10,
      droppedInbound: () => 0
    })

    for (let i = 0; i < 5; i += 1) source.push(datagram(4))
    await settle()

    // 10 bytes of credit: the first two leave 2 bytes, the third crosses into
    // the red and is the last one through. The fourth is blocked.
    expect(sent).toHaveLength(3)
  })

  it('resumes when the renderer releases credit', async () => {
    const sent: BrokerToRendererMessage[] = []
    const source = manualReadable()
    const pump = createDatagramPump({
      handleId: 'h1',
      readable: source.readable,
      send: (m) => { sent.push(m) },
      initialCredit: 2,
      initialCreditBytes: 1_000_000,
      droppedInbound: () => 0
    })

    for (let i = 0; i < 3; i += 1) source.push(datagram())
    await settle()
    expect(sent).toHaveLength(2)

    // Reports consuming one of the two delivered so far -- a delta the
    // window ceiling (2) can actually accommodate, unlike a renderer
    // claiming to have consumed more than it was ever sent.
    pump.handleCredit({ kind: 'datagram-credit', handleId: 'h1', datagramsConsumed: 1, bytesConsumed: 4 })
    await settle()

    expect(sent).toHaveLength(3)
  })

  it('clamps an over-reported credit delta to each counter\'s own window ceiling', async () => {
    const sent: BrokerToRendererMessage[] = []
    const source = manualReadable()
    const pump = createDatagramPump({
      handleId: 'h1',
      readable: source.readable,
      send: (m) => { sent.push(m) },
      initialCredit: 2,
      initialCreditBytes: 20,
      droppedInbound: () => 0
    })

    for (let i = 0; i < 2; i += 1) source.push(datagram(4))
    await settle()
    expect(sent).toHaveLength(2)

    // An absurd self-reported delta. Without the clamp this would push
    // credit/creditBytes to roughly 1e9 and every one of the ten datagrams
    // below would be delivered; with it, at most `initialCredit` more can
    // go through no matter how large the reported delta is.
    pump.handleCredit({
      kind: 'datagram-credit', handleId: 'h1', datagramsConsumed: 1e9, bytesConsumed: 1e9
    })
    for (let i = 0; i < 10; i += 1) source.push(datagram(4))
    await settle()

    expect(sent).toHaveLength(4)
  })

  it('ignores a credit message addressed to a different handle', async () => {
    const sent: BrokerToRendererMessage[] = []
    const source = manualReadable()
    const pump = createDatagramPump({
      handleId: 'h1',
      readable: source.readable,
      send: (m) => { sent.push(m) },
      initialCredit: 2,
      initialCreditBytes: 1_000_000,
      droppedInbound: () => 0
    })

    for (let i = 0; i < 3; i += 1) source.push(datagram())
    await settle()
    expect(sent).toHaveLength(2)

    // A legitimate-looking credit for a DIFFERENT handle. If this pump
    // applied it anyway, the third queued datagram would be delivered too.
    pump.handleCredit({ kind: 'datagram-credit', handleId: 'h2', datagramsConsumed: 1, bytesConsumed: 4 })
    await settle()

    expect(sent).toHaveLength(2)
  })

  it('ignores a credit message with a nonsense count rather than trusting it', async () => {
    const sent: BrokerToRendererMessage[] = []
    const source = manualReadable()
    const pump = createDatagramPump({
      handleId: 'h1',
      readable: source.readable,
      send: (m) => { sent.push(m) },
      initialCredit: 1,
      initialCreditBytes: 1_000_000,
      droppedInbound: () => 0
    })
    for (let i = 0; i < 3; i += 1) source.push(datagram())
    await settle()

    pump.handleCredit({
      kind: 'datagram-credit', handleId: 'h1', datagramsConsumed: Number.NaN, bytesConsumed: -5
    })
    await settle()

    expect(sent).toHaveLength(1)
  })

  it('carries the running drop total on every datagram it does deliver', async () => {
    const sent: BrokerToRendererMessage[] = []
    const source = manualReadable()
    let dropped = 0
    createDatagramPump({
      handleId: 'h1',
      readable: source.readable,
      send: (m) => { sent.push(m) },
      initialCredit: 8,
      initialCreditBytes: 4096,
      droppedInbound: () => dropped
    })

    source.push(datagram())
    await settle()
    dropped = 12
    source.push(datagram())
    await settle()

    expect(sent.map((m) => 'dropped' in m ? m.dropped : undefined)).toEqual([0, 12])
  })

  // Without this the count freezes at its last delivered value during exactly
  // the overload it exists to report: when everything is being dropped, there
  // is no datagram left to piggyback it on.
  it('reports drops on their own while the window is exhausted', async () => {
    const sent: BrokerToRendererMessage[] = []
    const source = manualReadable()
    let dropped = 0
    createDatagramPump({
      handleId: 'h1',
      readable: source.readable,
      send: (m) => { sent.push(m) },
      initialCredit: 1,
      initialCreditBytes: 1_000_000,
      droppedInbound: () => dropped,
      dropReportMs: 5
    })

    for (let i = 0; i < 3; i += 1) source.push(datagram())
    await settle()
    dropped = 4
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(sent).toContainEqual({ kind: 'datagram-dropped', handleId: 'h1', dropped: 4 })
  })

  it('does not repeat a drop report when nothing new was dropped', async () => {
    const sent: BrokerToRendererMessage[] = []
    const source = manualReadable()
    let dropped = 0
    const pump = createDatagramPump({
      handleId: 'h1',
      readable: source.readable,
      send: (m) => { sent.push(m) },
      initialCredit: 1,
      initialCreditBytes: 1_000_000,
      droppedInbound: () => dropped,
      dropReportMs: 5
    })
    for (let i = 0; i < 3; i += 1) source.push(datagram())
    await settle()

    // One burst of drops, then a steady count across many report intervals.
    // A timer that reported the TOTAL rather than the CHANGE would emit on
    // every tick and turn a drop storm into a message storm.
    dropped = 4
    await new Promise((resolve) => setTimeout(resolve, 60))
    pump.stop()

    expect(sent.filter((m) => m.kind === 'datagram-dropped')).toHaveLength(1)
  })

  it('ends the stream cleanly when the socket closes', async () => {
    const sent: BrokerToRendererMessage[] = []
    const source = manualReadable()
    createDatagramPump({
      handleId: 'h1',
      readable: source.readable,
      send: (m) => { sent.push(m) },
      initialCredit: 8,
      initialCreditBytes: 4096,
      droppedInbound: () => 0
    })

    source.close()
    await settle()

    expect(sent).toEqual([{ kind: 'end', handleId: 'h1' }])
  })

  it('fails the handle when the socket dies underneath it', async () => {
    const sent: BrokerToRendererMessage[] = []
    const onStreamFailed = vi.fn()
    const source = manualReadable()
    createDatagramPump({
      handleId: 'h1',
      readable: source.readable,
      send: (m) => { sent.push(m) },
      initialCredit: 8,
      initialCreditBytes: 4096,
      droppedInbound: () => 0,
      mapError: () => 'reset',
      onStreamFailed
    })

    source.error(new Error('gone'))
    await settle()

    expect(sent).toEqual([{ kind: 'end', handleId: 'h1', code: 'reset' }])
    expect(onStreamFailed).toHaveBeenCalledTimes(1)
  })

  it('stops posting after stop(), even with a datagram already queued', async () => {
    const sent: BrokerToRendererMessage[] = []
    const source = manualReadable()
    const pump = createDatagramPump({
      handleId: 'h1',
      readable: source.readable,
      send: (m) => { sent.push(m) },
      initialCredit: 8,
      initialCreditBytes: 4096,
      droppedInbound: () => 0
    })

    // Queued BEFORE stop(): the read is already pending, so this is the case
    // where a datagram could slip out after teardown began.
    source.push(datagram())
    pump.stop()
    await settle()

    expect(sent.filter((m) => m.kind === 'datagram')).toHaveLength(0)
  })
})
