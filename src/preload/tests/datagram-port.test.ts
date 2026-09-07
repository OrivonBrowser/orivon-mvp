import { describe, expect, it, vi } from 'vitest'
import { createDatagramPort } from '../datagram-port.js'
import type { WireDatagram } from '../datagram-port.js'
import type { PortLike } from '../socket-port.js'
import { DATAGRAM_CREDIT_COALESCE } from '../../contracts/ipc.js'

// The isolated-world end of the datagram relay. Driven through a fake port,
// the same way socket-port.test.ts drives its own.

function fakePort (): PortLike & { readonly sent: unknown[], emit: (message: unknown) => void, closed: () => boolean } {
  const sent: unknown[] = []
  let listener: ((message: unknown) => void) | undefined
  let isClosed = false
  return {
    sent,
    postMessage: (message) => { sent.push(message) },
    onMessage: (cb) => { listener = cb },
    close: () => { isClosed = true },
    emit: (message) => { listener?.(message) },
    closed: () => isClosed
  }
}

function datagram (byteLength = 4): WireDatagram {
  return { data: new Uint8Array(byteLength), address: '93.184.216.34', port: 6881, family: 'IPv4' }
}

const settle = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)) }

describe('createDatagramPort -- inbound', () => {
  it('hands each datagram to the consumer whole', () => {
    const port = fakePort()
    const received: WireDatagram[] = []
    const dp = createDatagramPort({ handleId: 'h1', port })
    dp.onDatagram((d) => { received.push(d) })

    port.emit({
      kind: 'datagram', handleId: 'h1', data: new Uint8Array([7]),
      address: '10.0.0.9', port: 1234, family: 'IPv4', dropped: 0
    })

    expect(received).toEqual([{ data: new Uint8Array([7]), address: '10.0.0.9', port: 1234, family: 'IPv4' }])
  })

  it('tracks the running inbound drop total off delivered datagrams', () => {
    const port = fakePort()
    const dp = createDatagramPort({ handleId: 'h1', port })
    const seen: Array<[number, number]> = []
    dp.onDropped((inbound, outbound) => { seen.push([inbound, outbound]) })

    port.emit({
      kind: 'datagram', handleId: 'h1', data: new Uint8Array([1]),
      address: 'a', port: 1, family: 'IPv4', dropped: 5
    })

    expect(seen).toEqual([[5, 0]])
  })

  it('tracks it from a standalone drop report too, which is the overload case', () => {
    // When everything is being dropped there is no datagram left to carry the
    // count -- which is the exact moment the app most wants it.
    const port = fakePort()
    const dp = createDatagramPort({ handleId: 'h1', port })
    const seen: Array<[number, number]> = []
    dp.onDropped((inbound, outbound) => { seen.push([inbound, outbound]) })

    port.emit({ kind: 'datagram-dropped', handleId: 'h1', dropped: 9 })

    expect(seen).toEqual([[9, 0]])
  })

  it('never lets the drop total go backwards', () => {
    const port = fakePort()
    const dp = createDatagramPort({ handleId: 'h1', port })
    const seen: Array<[number, number]> = []
    dp.onDropped((inbound, outbound) => { seen.push([inbound, outbound]) })

    port.emit({ kind: 'datagram-dropped', handleId: 'h1', dropped: 9 })
    port.emit({ kind: 'datagram-dropped', handleId: 'h1', dropped: 3 })

    expect(seen).toEqual([[9, 0]])
  })
})

describe('createDatagramPort -- credit', () => {
  it('coalesces small consumption reports rather than sending one each', async () => {
    const port = fakePort()
    const dp = createDatagramPort({ handleId: 'h1', port })

    dp.reportConsumed(1, 10)
    dp.reportConsumed(1, 20)
    await settle()

    expect(port.sent).toEqual([
      { kind: 'datagram-credit', handleId: 'h1', datagramsConsumed: 2, bytesConsumed: 30 }
    ])
  })

  it('flushes immediately once the coalescing threshold is reached', () => {
    const port = fakePort()
    const dp = createDatagramPort({ handleId: 'h1', port })

    dp.reportConsumed(DATAGRAM_CREDIT_COALESCE, 100)

    expect(port.sent).toHaveLength(1)
  })

  it('ignores a non-positive report rather than sending an empty credit', async () => {
    const port = fakePort()
    const dp = createDatagramPort({ handleId: 'h1', port })

    dp.reportConsumed(0, 0)
    await settle()

    expect(port.sent).toHaveLength(0)
  })
})

describe('createDatagramPort -- outbound', () => {
  it('posts a send message for each datagram', async () => {
    const port = fakePort()
    const dp = createDatagramPort({ handleId: 'h1', port })

    await dp.send(datagram())

    expect(port.sent).toEqual([expect.objectContaining({ kind: 'send', handleId: 'h1', port: 6881 })])
  })

  it('blocks once the outbound window is full, and resumes on an ack', async () => {
    const port = fakePort()
    const dp = createDatagramPort({ handleId: 'h1', port, windowDatagrams: 2 })

    await dp.send(datagram())
    await dp.send(datagram())
    let third = false
    const pending = dp.send(datagram()).then(() => { third = true })
    await settle()
    expect(third).toBe(false)

    port.emit({ kind: 'send-ack', handleId: 'h1', datagramsAccepted: 2 })
    await pending

    expect(third).toBe(true)
  })

  // A87: the app's writable can only report a rejection by erroring the
  // stream, and a DHT peer list routinely names addresses outside a grant.
  it('resolves a refused send rather than rejecting it', async () => {
    const port = fakePort()
    const dp = createDatagramPort({ handleId: 'h1', port, windowDatagrams: 1 })

    await expect(dp.send(datagram())).resolves.toBeUndefined()
    port.emit({ kind: 'send-failed', handleId: 'h1', code: 'denied', dropped: 1 })

    await expect(dp.send(datagram())).resolves.toBeUndefined()
  })

  it('counts a refusal and releases its window slot', async () => {
    const port = fakePort()
    const dp = createDatagramPort({ handleId: 'h1', port, windowDatagrams: 1 })
    const seen: Array<[number, number]> = []
    dp.onDropped((inbound, outbound) => { seen.push([inbound, outbound]) })

    await dp.send(datagram())
    port.emit({ kind: 'send-failed', handleId: 'h1', code: 'denied', dropped: 1 })
    await dp.send(datagram())

    expect(seen).toEqual([[0, 1]])
    expect(port.sent.filter((m) => (m as { kind?: string }).kind === 'send')).toHaveLength(2)
  })
})

describe('createDatagramPort -- terminal states', () => {
  it('resolves closed on a clean end', async () => {
    const port = fakePort()
    const dp = createDatagramPort({ handleId: 'h1', port })

    port.emit({ kind: 'end', handleId: 'h1' })

    await expect(dp.closed).resolves.toBeUndefined()
  })

  it('rejects closed on an abrupt end, carrying the code', async () => {
    const port = fakePort()
    const dp = createDatagramPort({ handleId: 'h1', port })

    port.emit({ kind: 'end', handleId: 'h1', code: 'reset' })

    await expect(dp.closed).rejects.toMatchObject({ code: 'reset' })
  })

  it('reports the port going silent with sends outstanding', async () => {
    const port = fakePort()
    const onFatal = vi.fn()
    const dp = createDatagramPort({ handleId: 'h1', port, silenceTimeoutMs: 10 })
    dp.onFatal(onFatal)

    await dp.send(datagram())
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(onFatal).toHaveBeenCalledWith('timeout')
    await expect(dp.closed).rejects.toMatchObject({ code: 'timeout' })
  })

  it('does not arm the silence timer when nothing is outstanding', async () => {
    const port = fakePort()
    const onFatal = vi.fn()
    const dp = createDatagramPort({ handleId: 'h1', port, silenceTimeoutMs: 10 })
    dp.onFatal(onFatal)

    await dp.send(datagram())
    port.emit({ kind: 'send-ack', handleId: 'h1', datagramsAccepted: 1 })
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(onFatal).not.toHaveBeenCalled()
  })

  it('sends nothing more after dispose()', async () => {
    const port = fakePort()
    const dp = createDatagramPort({ handleId: 'h1', port })

    dp.dispose()
    await dp.send(datagram())
    dp.reportConsumed(5, 50)
    await settle()

    expect(port.sent).toHaveLength(0)
  })

  it('ignores a byte-path message that lands on a datagram port', () => {
    const port = fakePort()
    const received: WireDatagram[] = []
    const dp = createDatagramPort({ handleId: 'h1', port })
    dp.onDatagram((d) => { received.push(d) })

    port.emit({ kind: 'data', handleId: 'h1', chunk: new Uint8Array([1]) })

    expect(received).toHaveLength(0)
  })
})
