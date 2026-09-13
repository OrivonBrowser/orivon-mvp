// installOrivon's net.udpBind coverage -- split out of main-world-socket.
// test.ts (code-guidelines.md Rule 2: that file crossed the 800-line test
// limit; this concern has no dependency on the TCP-socket tests it split
// from, so it moved out whole rather than being trimmed in place). Shared
// fixtures live in ./main-world-socket.test-helpers.ts.

import { describe, expect, it } from 'vitest'
import { installOrivon } from '../main-world-socket.js'
import type { MainWorldDatagram } from '../main-world-socket.js'
import type { SendRefusal } from '../../contracts/handles.js'
import { LIMITS, fakeBridge, fakeSocketBridgeResult, fakeUdpBridgeResult, tick } from './main-world-socket.test-helpers.js'

describe('installOrivon -- net.udpBind', () => {
  function bindTarget (udp = fakeUdpBridgeResult()): {
    orivon: { net: { udpBind: (opts: unknown) => Promise<Record<string, unknown>> } }
    udp: ReturnType<typeof fakeUdpBridgeResult>
  } {
    const target: Record<string, unknown> = {}
    installOrivon(fakeBridge(fakeSocketBridgeResult(), udp), LIMITS, target)
    return { orivon: target.orivon as never, udp }
  }

  it('resolves to a UdpSocket-shaped object with real WHATWG streams', async () => {
    const { orivon } = bindTarget()
    const socket = await orivon.net.udpBind({ port: 6881 })

    expect(socket.id).toBe('u1')
    expect(socket.localAddress).toBe('0.0.0.0')
    expect(socket.localPort).toBe(6881)
    expect(socket.readable).toBeInstanceOf(ReadableStream)
    expect(socket.writable).toBeInstanceOf(WritableStream)
  })

  it('delivers inbound datagrams whole, one chunk per packet', async () => {
    const { orivon, udp } = bindTarget()
    const socket = await orivon.net.udpBind({ port: 6881 })
    const reader = (socket.readable as ReadableStream<MainWorldDatagram>).getReader()

    udp.emit({ data: new Uint8Array([1, 2]), address: '10.0.0.9', port: 1234, family: 'IPv4' })
    const { value } = await reader.read()

    expect(value).toEqual({ data: new Uint8Array([1, 2]), address: '10.0.0.9', port: 1234, family: 'IPv4' })
    reader.releaseLock()
  })

  // The trap: a number copied once at acquisition reads zero forever, and an
  // app checking it would conclude it had lost nothing.
  it('exposes both loss counters as live getters, not values frozen at bind', async () => {
    const { orivon, udp } = bindTarget()
    const socket = await orivon.net.udpBind({ port: 6881 })

    expect(socket.droppedInbound).toBe(0)
    expect(socket.droppedOutbound).toBe(0)
    udp.emitDropped(4, 7)

    expect(socket.droppedInbound).toBe(4)
    expect(socket.droppedOutbound).toBe(7)
  })

  it('keeps the counters readable through Object.freeze', async () => {
    const { orivon, udp } = bindTarget()
    const socket = await orivon.net.udpBind({ port: 6881 })
    expect(Object.isFrozen(socket)).toBe(true)
    udp.emitDropped(1, 2)
    expect(socket.droppedInbound).toBe(1)
  })

  it('sends what the page writes', async () => {
    const { orivon, udp } = bindTarget()
    const socket = await orivon.net.udpBind({ port: 6881 })
    const writer = (socket.writable as WritableStream<MainWorldDatagram>).getWriter()

    await writer.write({ data: new Uint8Array([9]), address: '93.184.216.34', port: 6881, family: 'IPv4' })

    expect(udp.sent).toEqual([{ data: new Uint8Array([9]), address: '93.184.216.34', port: 6881, family: 'IPv4' }])
    writer.releaseLock()
  })

  it('reports what the page drained, so the broker can release credit', async () => {
    const { orivon, udp } = bindTarget()
    const socket = await orivon.net.udpBind({ port: 6881 })
    const reader = (socket.readable as ReadableStream<MainWorldDatagram>).getReader()

    udp.emit({ data: new Uint8Array(12), address: 'a', port: 1, family: 'IPv4' })
    await reader.read()
    await tick()

    expect(udp.consumed).toContainEqual({ datagrams: 1, bytes: 12 })
    reader.releaseLock()
  })

  it('errors both streams when the read side ends abruptly', async () => {
    const { orivon, udp } = bindTarget()
    const socket = await orivon.net.udpBind({ port: 6881 })
    const reader = (socket.readable as ReadableStream<MainWorldDatagram>).getReader()

    udp.emitEnd('reset')

    await expect(reader.read()).rejects.toMatchObject({ code: 'reset' })
    await expect((socket.writable as WritableStream<MainWorldDatagram>).getWriter().closed)
      .rejects.toMatchObject({ code: 'reset' })
  })

  it('does not throw when a genuine read-end arrives after onFatal already errored the controllers', async () => {
    // onFatal's own controller calls are all try/catch-guarded for exactly
    // this race; onReadEnd's were not, so a belated 'end' after a silence
    // timeout already errored the stream would throw on an already-errored
    // controller instead of being a harmless no-op.
    const { orivon, udp } = bindTarget()
    const socket = await orivon.net.udpBind({ port: 6881 })
    const reader = (socket.readable as ReadableStream<MainWorldDatagram>).getReader()

    udp.emitFatal('timeout')

    expect(() => { udp.emitEnd() }).not.toThrow()
    await expect(reader.read()).rejects.toMatchObject({ code: 'timeout' })
  })

  // A87: a refused send never rejects `writable` -- this is how the app
  // actually learns which of its own writes was refused and why.
  it('delivers a refused send on `refusals`, carrying its destination and code', async () => {
    const { orivon, udp } = bindTarget()
    const socket = await orivon.net.udpBind({ port: 6881 })
    const reader = (socket.refusals as ReadableStream<SendRefusal>).getReader()

    udp.emitRefusal({ address: '10.0.0.5', port: 4321, code: 'denied' })
    const { value } = await reader.read()

    expect(value).toEqual({ address: '10.0.0.5', port: 4321, code: 'denied' })
    reader.releaseLock()
  })

  it('drops a refusal rather than growing the queue once it is full', async () => {
    // `refusals` reports OUTBOUND send refusals, so it is sized off
    // LIMITS.outboundDatagramWindow (4), not the inbound window -- no
    // wire-level credit window paces refusals the way it paces inbound
    // datagrams, so an app that never reads `refusals` must not let the
    // broker's refusals pin unbounded memory here. Five refusals fired at an
    // unread stream must leave exactly four queued, the fifth dropped rather
    // than growing the queue past the mark.
    const { orivon, udp } = bindTarget()
    const socket = await orivon.net.udpBind({ port: 6881 })
    const reader = (socket.refusals as ReadableStream<SendRefusal>).getReader()

    for (let i = 0; i < 5; i += 1) udp.emitRefusal({ address: '10.0.0.5', port: 4321 + i, code: 'denied' })

    const drained: SendRefusal[] = []
    for (let i = 0; i < 4; i += 1) drained.push((await reader.read()).value as SendRefusal)
    expect(drained.map((r) => r.port)).toEqual([4321, 4322, 4323, 4324])

    // The fifth refusal (port 4325) must have been dropped outright rather
    // than merely left queued behind the four already drained -- a sentinel
    // enqueued now lands in the read right after them only if the queue was
    // actually empty, which is what distinguishes "dropped" from "unread".
    udp.emitRefusal({ address: '10.0.0.5', port: 9999, code: 'denied' })
    expect((await reader.read()).value).toEqual({ address: '10.0.0.5', port: 9999, code: 'denied' })
    reader.releaseLock()
  })
})
