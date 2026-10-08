// net.cancel (ADR-0071): a page withdrawing one of its own pending dials. The signal the broker's dial receives is aborted
// by it, and by nothing a different frame or origin sends.

import { describe, expect, it } from 'vitest'
import { handleControlRequest } from '../ipc.js'
import type { RequestEnvelope } from '../../../contracts/ipc.js'
import { fail } from '../../errors.js'
import { createControlLimiter } from '../control-limiter.js'
import { APP, OTHER, envelope, fakePortPair, fakeTcpSocket, fakeTransport, frameFor, stubBroker } from './ipc.test-helpers.js'

const CONNECT = { host: 'x.example', port: 443 }

function dialEnvelope (id: string, method = 'net.connect', payload: unknown = CONNECT): RequestEnvelope<unknown> {
  return { id, method, payload, timeoutMs: 5_000 }
}

function cancelEnvelope (requestId: unknown): RequestEnvelope<unknown> {
  return { id: 'cancel-1', method: 'net.cancel', payload: { requestId }, timeoutMs: 5_000 }
}

/** A broker whose connect waits for its signal, as a real dial does, and records the signals it was given. */
function hungBroker (): { broker: ReturnType<typeof stubBroker>, signals: AbortSignal[] } {
  const signals: AbortSignal[] = []
  const broker = stubBroker([], {
    connect: async (_origin, opts) => await new Promise((_resolve, reject) => {
      const signal = opts.signal
      if (signal === undefined) return
      signals.push(signal)
      if (signal.aborted) reject(fail('closed', 'abandoned'))
      signal.addEventListener('abort', () => { reject(fail('closed', 'abandoned')) }, { once: true })
    })
  })
  return { broker, signals }
}

const tick = async (): Promise<void> => { await new Promise((resolve) => { setTimeout(resolve, 0) }) }

describe('net.cancel', () => {
  it('aborts the dial of the request it names, and that request answers closed', async () => {
    const { broker, signals } = hungBroker()
    const transport = fakeTransport(fakePortPair().pair)
    const event = frameFor(APP)
    const dial = handleControlRequest(broker, event, dialEnvelope('r1'), transport)
    await tick()

    const cancel = await handleControlRequest(broker, event, cancelEnvelope('r1'), transport)

    expect(cancel).toMatchObject({ ok: true })
    expect(signals[0]?.aborted).toBe(true)
    expect(await dial).toMatchObject({ id: 'r1', ok: false, code: 'closed' })
  })

  it('reaches a dial the control limiter is still holding back', async () => {
    const { broker, signals } = hungBroker()
    const transport = fakeTransport(fakePortPair().pair)
    const event = frameFor(APP)
    let release!: () => void
    const held = new Promise<boolean>((resolve) => { release = () => { resolve(true) } })
    const limiter = { tryConsume: async () => await held } as unknown as ReturnType<typeof createControlLimiter>
    const dial = handleControlRequest(broker, event, dialEnvelope('r1'), transport, limiter)
    await tick()

    await handleControlRequest(broker, event, cancelEnvelope('r1'), transport)
    release()
    await dial
    await tick()

    expect(signals[0]?.aborted).toBe(true)
  })

  it('works for net.connectSecure too', async () => {
    const signals: AbortSignal[] = []
    const broker = stubBroker([], {
      connectSecure: async (_origin, opts) => await new Promise((_resolve, reject) => {
        if (opts.signal === undefined) return
        signals.push(opts.signal)
        opts.signal.addEventListener('abort', () => { reject(fail('closed', 'abandoned')) }, { once: true })
      })
    })
    const transport = fakeTransport(fakePortPair().pair)
    const event = frameFor(APP)
    const dial = handleControlRequest(broker, event, dialEnvelope('r1', 'net.connectSecure', { host: 'x.example', port: 443 }), transport)
    await tick()

    await handleControlRequest(broker, event, cancelEnvelope('r1'), transport)

    expect(await dial).toMatchObject({ ok: false, code: 'closed' })
    expect(signals[0]?.aborted).toBe(true)
  })

  it('cannot cancel a dial another frame of the same origin began', async () => {
    const { broker, signals } = hungBroker()
    const transport = fakeTransport(fakePortPair().pair)
    void handleControlRequest(broker, frameFor(APP), dialEnvelope('r1'), transport)
    await tick()

    await handleControlRequest(broker, frameFor(APP), cancelEnvelope('r1'), transport)

    expect(signals[0]?.aborted).toBe(false)
  })

  it('cannot cancel a dial of another origin, whatever the frame', async () => {
    const { broker, signals } = hungBroker()
    const transport = fakeTransport(fakePortPair().pair)
    const event = frameFor(APP)
    void handleControlRequest(broker, event, dialEnvelope('r1'), transport)
    await tick()

    const spoof = { senderFrame: { ...event.senderFrame, origin: OTHER, url: `${OTHER}/` }, sender: event.sender } as typeof event
    await handleControlRequest(broker, spoof, cancelEnvelope('r1'), transport)

    expect(signals[0]?.aborted).toBe(false)
  })

  it('does nothing for a request that already answered, or that never was', async () => {
    const { socket } = fakeTcpSocket()
    const broker = stubBroker([], { connect: async () => socket })
    const transport = fakeTransport(fakePortPair().pair)
    const event = frameFor(APP)
    await handleControlRequest(broker, event, dialEnvelope('r1'), transport)

    const late = await handleControlRequest(broker, event, cancelEnvelope('r1'), transport)
    const unknown = await handleControlRequest(broker, event, cancelEnvelope('nope'), transport)

    expect(late).toMatchObject({ ok: true })
    expect(unknown).toMatchObject({ ok: true })
    expect(socket.closed).toBeDefined()
  })

  it('refuses a payload without a request id as invalid', async () => {
    const response = await handleControlRequest(stubBroker([]), frameFor(APP), cancelEnvelope(7), fakeTransport(fakePortPair().pair))

    expect(response).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('spends no control token: it draws on the handle budget', async () => {
    const limiter = { tryConsume: async () => false, admitHandleIo: async () => true } as unknown as ReturnType<typeof createControlLimiter>

    const response = await handleControlRequest(stubBroker([]), frameFor(APP), cancelEnvelope('r1'), fakeTransport(fakePortPair().pair), limiter)

    expect(response).toMatchObject({ ok: true })
  })

  it('ignores a signal a page puts in the net.connect payload and refuses one in net.connectSecure', async () => {
    const seen: unknown[] = []
    const { socket } = fakeTcpSocket()
    const broker = stubBroker([], { connect: async (_o, opts) => { seen.push(opts.signal); return socket } })
    const transport = fakeTransport(fakePortPair().pair)

    await handleControlRequest(broker, frameFor(APP), envelope('net.connect', { ...CONNECT, signal: {} }), transport)
    const secure = await handleControlRequest(broker, frameFor(APP), envelope('net.connectSecure', { ...CONNECT, signal: {} }), transport)

    expect(seen[0]).toBeInstanceOf(AbortSignal)
    expect(secure).toMatchObject({ ok: false, code: 'invalid' })
  })
})

describe('a dial abandoned in the moment it finished', () => {
  it('closes the socket the broker returned and answers closed, delivering no port', async () => {
    const { socket } = fakeTcpSocket()
    let release!: () => void
    const finished = new Promise<void>((resolve) => { release = resolve })
    const broker = stubBroker([], { connect: async () => { await finished; return socket } })
    const transport = fakeTransport(fakePortPair().pair)
    const event = frameFor(APP)
    const dial = handleControlRequest(broker, event, dialEnvelope('r1'), transport)
    await tick()

    await handleControlRequest(broker, event, cancelEnvelope('r1'), transport)
    release()

    expect(await dial).toMatchObject({ ok: false, code: 'closed' })
    expect(event.senderFrame?.postMessage).not.toHaveBeenCalled()
  })
})
