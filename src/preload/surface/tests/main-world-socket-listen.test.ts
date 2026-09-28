// installOrivon's net.listen coverage (A114, d-0028) -- ./main-world-socket-
// udp.test.ts's own sibling and split out the same way: a whole concern, no
// dependency on the TCP-socket-dial tests it would otherwise share a file
// with. Shared fixtures live in ./main-world-socket.test-helpers.ts.
//
// THE FIRST DESCRIBE BLOCK IS THE ONE THAT MATTERS MOST FOR THIS LANE: it
// proves highWaterMark: 0 survives all the way into the page's own
// ReadableStream, not just at the broker (accept-pump.test.ts) or the
// isolated-world preload layer (ports/tests/server.test.ts) -- the property
// open-questions.md A185 names as the one most likely to be silently
// destroyed by a page-side wrapper.

import { describe, expect, it } from 'vitest'
import { installOrivon } from '../main-world-socket.js'
import { LIMITS, fakeBridge, fakeServerBridgeResult, fakeSocketBridgeResult, tick } from './main-world-socket.test-helpers.js'

describe('installOrivon -- net.listen backpressure (highWaterMark: 0, end to end)', () => {
  function listenTarget (server = fakeServerBridgeResult()): {
    orivon: { net: { listen: (opts: unknown) => Promise<Record<string, unknown>> } }
    server: ReturnType<typeof fakeServerBridgeResult>
  } {
    const target: Record<string, unknown> = {}
    installOrivon(fakeBridge(fakeSocketBridgeResult(), undefined, undefined, undefined, server), LIMITS, target)
    return { orivon: target.orivon as never, server }
  }

  it('an unread server accepts none -- reportAccepted is never called before the page reads', async () => {
    const { orivon, server } = listenTarget()
    await orivon.net.listen({ port: 4001 })

    await tick()

    expect(server.reportAcceptedCalls).toBe(0)
  })

  it('the first read() reports exactly one unit of accept demand, not zero and not more than one', async () => {
    const { orivon, server } = listenTarget()
    const tcpServer = await orivon.net.listen({ port: 4001 })
    const reader = (tcpServer.connections as ReadableStream).getReader()

    // Left pending on purpose -- this test only cares how much demand ONE
    // outstanding read() reports, not how it resolves.
    void reader.read()
    await tick()

    expect(server.reportAcceptedCalls).toBe(1)
  })

  it('N reads report exactly N units of demand -- never ahead of what the page actually asked for', async () => {
    const { orivon, server } = listenTarget()
    const tcpServer = await orivon.net.listen({ port: 4001 })
    const reader = (tcpServer.connections as ReadableStream).getReader()

    // Each read() is fully resolved -- a connection delivered and awaited --
    // before the next one is issued, so reportAcceptedCalls can only move in
    // lockstep with genuine, sequential page reads, never ahead of them.
    const r1 = reader.read()
    await tick()
    expect(server.reportAcceptedCalls).toBe(1)
    server.emitConnection(fakeSocketBridgeResult())
    await r1

    const r2 = reader.read()
    await tick()
    expect(server.reportAcceptedCalls).toBe(2)
    server.emitConnection(fakeSocketBridgeResult())
    await r2

    void reader.read()
    await tick()
    expect(server.reportAcceptedCalls).toBe(3)
  })
})

describe('installOrivon -- net.listen wiring', () => {
  function listenTarget (server = fakeServerBridgeResult()): {
    orivon: { net: { listen: (opts: unknown) => Promise<Record<string, unknown>> } }
    server: ReturnType<typeof fakeServerBridgeResult>
  } {
    const target: Record<string, unknown> = {}
    installOrivon(fakeBridge(fakeSocketBridgeResult(), undefined, undefined, undefined, server), LIMITS, target)
    return { orivon: target.orivon as never, server }
  }

  it('resolves to a TcpServer-shaped object with a real WHATWG connections stream', async () => {
    const { orivon } = listenTarget()
    const tcpServer = await orivon.net.listen({ port: 4001 })

    expect(tcpServer.id).toBe('s1')
    expect(tcpServer.localAddress).toBe('0.0.0.0')
    expect(tcpServer.localPort).toBe(6881)
    expect(tcpServer.connections).toBeInstanceOf(ReadableStream)
  })

  it('an accepted connection reads as a real TcpSocket -- an accepted socket and a dialled one are the same shape once accepted', async () => {
    const { orivon, server } = listenTarget()
    const tcpServer = await orivon.net.listen({ port: 4001 })
    const reader = (tcpServer.connections as ReadableStream).getReader()

    const reading = reader.read()
    await tick()
    server.emitConnection(fakeSocketBridgeResult())
    const { value: socket } = (await reading) as { value: Record<string, unknown> }

    expect(socket.id).toBe('h1')
    expect(socket.remoteAddress).toBe('93.184.216.34')
    expect(socket.readable).toBeInstanceOf(ReadableStream)
    expect(socket.writable).toBeInstanceOf(WritableStream)
    reader.releaseLock()
  })

  it('a clean end closes the connections stream', async () => {
    const { orivon, server } = listenTarget()
    const tcpServer = await orivon.net.listen({ port: 4001 })
    const reader = (tcpServer.connections as ReadableStream).getReader()

    const reading = reader.read()
    await tick()
    server.emitEnd()

    expect(await reading).toEqual({ done: true, value: undefined })
    reader.releaseLock()
  })

  it('an abrupt end errors the connections stream with a real OrivonError', async () => {
    const { orivon, server } = listenTarget()
    const tcpServer = await orivon.net.listen({ port: 4001 })
    const reader = (tcpServer.connections as ReadableStream).getReader()

    const reading = reader.read()
    await tick()
    server.emitEnd('revoked')

    await expect(reading).rejects.toMatchObject({ code: 'revoked' })
    reader.releaseLock()
  })

  it('close() calls through to the bridge and leaves the connections stream closed for future reads', async () => {
    const { orivon, server } = listenTarget()
    const tcpServer = await orivon.net.listen({ port: 4001 })

    await (tcpServer.close as () => Promise<void>)()

    expect(server.closeCalls).toBe(1)
    await expect((tcpServer.connections as ReadableStream).getReader().read())
      .resolves.toEqual({ done: true, value: undefined })
  })
})
