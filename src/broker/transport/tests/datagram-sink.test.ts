import { describe, expect, it, vi } from 'vitest'
import { createDatagramSink } from '../datagram-sink.js'
import type { BrokerToRendererMessage, SendMessage } from '../../../contracts/index.js'
import type { SendOutcome } from '../../broker-contracts.js'

// The OUTBOUND half of the datagram relay -- ../port-sink.ts's counterpart,
// and the place A87's decision actually lives: a refused datagram is reported
// as a counted failure that leaves the socket usable, never as something that
// errors the app's stream.

function sendMessage (overrides: Partial<SendMessage> = {}): SendMessage {
  return {
    kind: 'send',
    handleId: 'h1',
    data: new Uint8Array([1, 2, 3]),
    address: '93.184.216.34',
    port: 6881,
    ...overrides
  }
}

const settle = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)) }

function harness (sendDatagram: () => Promise<SendOutcome>, windowDatagrams = 4): {
  sent: BrokerToRendererMessage[]
  sink: ReturnType<typeof createDatagramSink>
  onSinkFailed: ReturnType<typeof vi.fn>
} {
  const sent: BrokerToRendererMessage[] = []
  const onSinkFailed = vi.fn()
  const sink = createDatagramSink({
    handleId: 'h1',
    send: (m) => { sent.push(m) },
    sendDatagram,
    windowDatagrams,
    onSinkFailed
  })
  return { sent, sink, onSinkFailed }
}

describe('createDatagramSink -- the happy path', () => {
  it('hands the datagram to the socket whole', async () => {
    const sendDatagram = vi.fn(async () => ({ sent: true as const }))
    const { sink } = harness(sendDatagram)

    sink.handleSend(sendMessage())
    await settle()

    expect(sendDatagram).toHaveBeenCalledWith({
      data: new Uint8Array([1, 2, 3]), address: '93.184.216.34', port: 6881, family: 'IPv4'
    })
  })

  it('acknowledges what it accepted so the renderer can release its window', async () => {
    const { sent, sink } = harness(async () => ({ sent: true }))

    sink.handleSend(sendMessage())
    sink.handleSend(sendMessage())
    await settle()

    const accepted = sent
      .filter((m) => m.kind === 'send-ack')
      .reduce((total, m) => total + (m.kind === 'send-ack' ? m.datagramsAccepted : 0), 0)
    expect(accepted).toBe(2)
  })

  it('coalesces acknowledgements rather than sending one per datagram', async () => {
    const { sent, sink } = harness(async () => ({ sent: true }))

    for (let i = 0; i < 4; i += 1) sink.handleSend(sendMessage())
    await settle()

    expect(sent.filter((m) => m.kind === 'send-ack')).toHaveLength(1)
  })
})

describe('createDatagramSink -- a refused datagram (A87)', () => {
  it('reports the refusal without ending the stream', async () => {
    const { sent, sink } = harness(async () => ({ sent: false, code: 'denied' }))

    sink.handleSend(sendMessage())
    await settle()

    expect(sent).toContainEqual(expect.objectContaining({ kind: 'send-failed', code: 'denied' }))
    expect(sent.filter((m) => m.kind === 'end')).toHaveLength(0)
  })

  it('does not fail the handle over one refused destination', async () => {
    // THE WHOLE POINT: a DHT peer list routinely names addresses outside a
    // grant. Failing the handle here would kill the swarm on the first one.
    const { sink, onSinkFailed } = harness(async () => ({ sent: false, code: 'denied' }))

    sink.handleSend(sendMessage())
    await settle()

    expect(onSinkFailed).not.toHaveBeenCalled()
  })

  it('keeps sending after a refusal', async () => {
    let calls = 0
    const { sent, sink } = harness(async () => {
      calls += 1
      return calls === 1 ? { sent: false, code: 'denied' } : { sent: true }
    })

    sink.handleSend(sendMessage())
    await settle()
    sink.handleSend(sendMessage())
    await settle()

    expect(calls).toBe(2)
    expect(sent).toContainEqual(expect.objectContaining({ kind: 'send-ack', datagramsAccepted: 1 }))
  })

  it('carries a running refusal total, so an app can tell one from many', async () => {
    const { sent, sink } = harness(async () => ({ sent: false, code: 'denied' }))

    sink.handleSend(sendMessage())
    await settle()
    sink.handleSend(sendMessage())
    await settle()

    expect(sent.filter((m) => m.kind === 'send-failed').map((m) => m.kind === 'send-failed' ? m.dropped : 0))
      .toEqual([1, 2])
  })
})

describe('createDatagramSink -- a renderer that ignores its window', () => {
  it('fails the handle rather than queueing past the window', async () => {
    // Not backpressure: the renderer was told the window and exceeded it, so
    // this is a broken or hostile renderer, and the same answer ../port-sink.ts
    // gives a write-window violation (T11b).
    const { sink, onSinkFailed } = harness(() => new Promise<SendOutcome>(() => {}), 2)

    sink.handleSend(sendMessage())
    sink.handleSend(sendMessage())
    sink.handleSend(sendMessage())
    await settle()

    expect(onSinkFailed).toHaveBeenCalledWith('limit', expect.anything())
  })

  it('releases the window as sends complete', async () => {
    const sendDatagram = vi.fn(async () => ({ sent: true as const }))
    const { sink, onSinkFailed } = harness(sendDatagram, 2)

    for (let i = 0; i < 6; i += 1) {
      sink.handleSend(sendMessage())
      await settle()
    }

    expect(onSinkFailed).not.toHaveBeenCalled()
    expect(sendDatagram).toHaveBeenCalledTimes(6)
  })
})

describe('createDatagramSink -- teardown', () => {
  it('sends nothing after stop()', async () => {
    const sendDatagram = vi.fn(async () => ({ sent: true as const }))
    const { sink } = harness(sendDatagram)

    sink.stop()
    sink.handleSend(sendMessage())
    await settle()

    expect(sendDatagram).not.toHaveBeenCalled()
  })

  it('posts nothing after stop(), even for a send already in flight', async () => {
    let resolveSend: (outcome: SendOutcome) => void = () => {}
    const { sent, sink } = harness(async () => await new Promise<SendOutcome>((r) => { resolveSend = r }))

    sink.handleSend(sendMessage())
    await settle()
    sink.stop()
    resolveSend({ sent: true })
    await settle()

    expect(sent).toHaveLength(0)
  })
})
