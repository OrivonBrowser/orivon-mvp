// The routed WebSocket once open: RFC 6455 framing both ways, the close
// handshake, and failing the connection on a peer that breaks the protocol.
// Run against websocket-route.test-helpers.ts's fake peer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bytes, concat } from './routed.test-helpers.js'
import { closeFrame, OP, openSocket, recordEvents, serverFrame, settle } from './websocket-route.test-helpers.js'
import type { ClientFrame } from './websocket-route.test-helpers.js'
import { WEBSOCKET_CLOSE_LINGER_MS, WEBSOCKET_CLOSING_TIMEOUT_MS } from '../websocket-route.js'

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

function text (frame: ClientFrame | undefined): string {
  return new TextDecoder().decode(frame?.payload)
}

function closeCodeOf (frame: ClientFrame | undefined): number | undefined {
  if (frame === undefined || frame.payload.byteLength < 2) return undefined
  return (frame.payload[0]! << 8) | frame.payload[1]!
}

describe('routed WebSocket -- receiving', () => {
  it('reassembles a fragmented text message, answering a ping between its fragments', async () => {
    const { ws, peer } = await openSocket()
    const seen = recordEvents(ws)
    peer.socket.push(concat(
      serverFrame(OP.text, 'Hel', { fin: false }),
      serverFrame(OP.ping, 'are you there'),
      serverFrame(OP.continuation, 'lo, ', { fin: false }),
      serverFrame(OP.continuation, 'w\u00f6rld')
    ))
    await settle()
    expect(seen).toEqual([{ message: 'Hello, w\u00f6rld' }])
    const pong = peer.frames().find((f) => f.opcode === OP.pong)
    expect([pong?.masked, text(pong)]).toEqual([true, 'are you there'])
  })

  it('parses frames split at every byte boundary, with 16- and 64-bit lengths', async () => {
    const { ws, peer } = await openSocket()
    ws.binaryType = 'arraybuffer'
    const seen: unknown[] = []
    ws.onmessage = (e: MessageEvent) => { seen.push(e.data instanceof ArrayBuffer ? e.data.byteLength : e.data) }
    const medium = new Uint8Array(300).fill(7)
    const large = new Uint8Array(70_000).fill(9)
    const wire = concat(serverFrame(OP.binary, medium), serverFrame(OP.binary, large), serverFrame(OP.text, 'tail'))
    for (let i = 0; i < 40; i++) peer.socket.push(wire.subarray(i, i + 1))
    peer.socket.push(wire.subarray(40))
    await settle()
    expect(seen).toEqual([300, 70_000, 'tail'])
  })

  it('delivers binary as a Blob by default and as an exact ArrayBuffer when asked', async () => {
    const { ws, peer } = await openSocket()
    const data: unknown[] = []
    ws.addEventListener('message', (e) => { data.push(e.data) })
    peer.socket.push(serverFrame(OP.binary, new Uint8Array([1, 2, 3])))
    await settle()
    ws.binaryType = 'arraybuffer'
    peer.socket.push(concat(serverFrame(OP.binary, new Uint8Array([4, 5])), serverFrame(OP.text, 'x')))
    await settle()
    expect(data[0]).toBeInstanceOf(Blob)
    expect([...new Uint8Array(await (data[0] as Blob).arrayBuffer())]).toEqual([1, 2, 3])
    expect(data[1]).toBeInstanceOf(ArrayBuffer)
    expect([...new Uint8Array(data[1] as ArrayBuffer)]).toEqual([4, 5])
  })

  it('stamps each message with the socket\'s origin', async () => {
    const { ws, peer } = await openSocket(undefined, 'wss://feed.example:8443/live')
    let origin = ''
    ws.onmessage = (e: MessageEvent) => { origin = e.origin }
    peer.socket.push(serverFrame(OP.text, 'x'))
    await settle()
    expect(origin).toBe('wss://feed.example:8443')
  })

  const violations: Array<[string, Uint8Array, number]> = [
    ['a masked server frame', serverFrame(OP.text, 'x', { mask: true }), 1002],
    ['a reserved bit', serverFrame(OP.text, 'x', { rsv: 4 }), 1002],
    ['a reserved opcode', serverFrame(3, 'x'), 1002],
    ['a continuation with nothing to continue', serverFrame(OP.continuation, 'x'), 1002],
    ['a new message inside a fragmented one', concat(serverFrame(OP.text, 'a', { fin: false }), serverFrame(OP.binary, 'b')), 1002],
    ['a fragmented control frame', serverFrame(OP.ping, 'x', { fin: false }), 1002],
    ['a control frame over 125 bytes', serverFrame(OP.ping, new Uint8Array(126)), 1002],
    ['invalid UTF-8 in a text message', serverFrame(OP.text, new Uint8Array([0xc3, 0x28])), 1007],
    ['a one-byte close payload', serverFrame(OP.close, new Uint8Array([3])), 1002],
    ['a close code reserved for reporting', closeFrame(1006), 1002]
  ]
  for (const [what, frame, code] of violations) {
    it(`fails on ${what}, telling the peer ${code}`, async () => {
      const { ws, peer } = await openSocket()
      const seen = recordEvents(ws)
      peer.socket.push(frame)
      await settle()
      expect(seen).toEqual(['error', { close: 1006, reason: '', wasClean: false }])
      expect(closeCodeOf(peer.frames().find((f) => f.opcode === OP.close))).toBe(code)
      expect([ws.readyState, peer.socket.closed]).toEqual([3, true])
    })
  }

  it('reports a dropped connection as an abnormal closure, with no error event', async () => {
    const { ws, peer } = await openSocket()
    const seen = recordEvents(ws)
    peer.socket.end()
    await settle()
    expect(seen).toEqual([{ close: 1006, reason: '', wasClean: false }])
  })
})

describe('routed WebSocket -- sending', () => {
  it('masks every frame and keeps text, ArrayBuffer, view and Blob sends in order', async () => {
    const { ws, peer } = await openSocket()
    const buffer = new Uint8Array([9, 8, 7, 6, 5]).buffer
    ws.send('h\u00e9')
    ws.send(new Blob([new Uint8Array([1, 2])]))
    ws.send(buffer)
    ws.send(new DataView(buffer, 1, 2))
    new Uint8Array(buffer)[0] = 0
    await settle()
    const sent = peer.frames()
    expect(sent.every((f) => f.masked && f.fin)).toBe(true)
    expect(sent.map((f) => [f.opcode, [...f.payload]])).toEqual([
      [OP.text, [...bytes('h\u00e9')]],
      [OP.binary, [1, 2]],
      [OP.binary, [9, 8, 7, 6, 5]],
      [OP.binary, [8, 7]]
    ])
  })

  it('counts bufferedAmount until the bytes are written', async () => {
    const { ws } = await openSocket()
    ws.send('abc')
    ws.send(new Uint8Array(1000))
    expect(ws.bufferedAmount).toBe(1003)
    await settle()
    expect(ws.bufferedAmount).toBe(0)
  })

  it('sends a large message whole, in pieces of its own', async () => {
    const { ws, peer } = await openSocket()
    const big = new Uint8Array(200_000).map((_, i) => i & 0xff)
    ws.send(big)
    await settle()
    const [frame] = peer.frames()
    expect(frame?.payload).toEqual(big)
    expect(peer.socket.written.slice(1).every((c) => c.byteOffset === 0 && c.byteLength === c.buffer.byteLength && c.byteLength <= 64 * 1024)).toBe(true)
  })
})

describe('routed WebSocket -- closing', () => {
  it('rejects a close code or reason the platform rejects', async () => {
    const { ws } = await openSocket()
    expect(() => { ws.close(1001) }).toThrow(expect.objectContaining({ name: 'InvalidAccessError' }) as Error)
    expect(() => { ws.close(5000) }).toThrow(expect.objectContaining({ name: 'InvalidAccessError' }) as Error)
    expect(() => { ws.close(1000, 'x'.repeat(124)) }).toThrow(expect.objectContaining({ name: 'SyntaxError' }) as Error)
    expect(ws.readyState).toBe(1)
  })

  it('a client close sends the code and reason, then closes cleanly on the server\'s answer', async () => {
    const { ws, peer } = await openSocket()
    const seen = recordEvents(ws)
    ws.close(4001, 'done here')
    expect(ws.readyState).toBe(2)
    ws.send('dropped')
    await settle()
    const close = peer.frames().find((f) => f.opcode === OP.close)
    expect([closeCodeOf(close), text(close).slice(2)]).toEqual([4001, 'done here'])
    expect(peer.frames().some((f) => f.opcode === OP.text)).toBe(false)
    peer.socket.push(closeFrame(4001, 'bye'))
    peer.socket.end()
    await settle()
    expect(seen).toEqual([{ close: 4001, reason: 'bye', wasClean: true }])
    expect(ws.readyState).toBe(3)
  })

  it('close() with no code sends an empty close frame; an empty answer reads as 1005', async () => {
    const { ws, peer } = await openSocket()
    const seen = recordEvents(ws)
    ws.close()
    await settle()
    expect(peer.frames().find((f) => f.opcode === OP.close)?.payload.byteLength).toBe(0)
    peer.socket.push(closeFrame())
    peer.socket.end()
    await settle()
    expect(seen).toEqual([{ close: 1005, reason: '', wasClean: true }])
  })

  it('a reason with no code closes with 1000', async () => {
    const { ws, peer } = await openSocket()
    ws.close(undefined, 'why')
    await settle()
    const close = peer.frames().find((f) => f.opcode === OP.close)
    expect([closeCodeOf(close), text(close).slice(2)]).toEqual([1000, 'why'])
  })

  it('answers a server close with the same code, then reports it once the server drops TCP', async () => {
    const { ws, peer } = await openSocket()
    const seen = recordEvents(ws)
    peer.socket.push(concat(closeFrame(1001, 'going away'), serverFrame(OP.text, 'after close')))
    await settle()
    expect(ws.readyState).toBe(2)
    expect(closeCodeOf(peer.frames().find((f) => f.opcode === OP.close))).toBe(1001)
    expect(seen).toEqual([])
    peer.socket.end()
    await settle()
    expect(seen).toEqual([{ close: 1001, reason: 'going away', wasClean: true }])
  })

  it('drops a server that closes but never drops TCP, still cleanly', async () => {
    const { ws, peer } = await openSocket()
    vi.useFakeTimers()
    const seen = recordEvents(ws)
    peer.socket.push(closeFrame(1000))
    await vi.advanceTimersByTimeAsync(WEBSOCKET_CLOSE_LINGER_MS + 10)
    expect(peer.socket.closed).toBe(true)
    expect(seen).toEqual([{ close: 1000, reason: '', wasClean: true }])
  })

  it('gives up on a server that never answers a client close', async () => {
    const { ws, peer } = await openSocket()
    vi.useFakeTimers()
    const seen = recordEvents(ws)
    ws.close(1000)
    await vi.advanceTimersByTimeAsync(WEBSOCKET_CLOSING_TIMEOUT_MS - 10)
    expect(seen).toEqual([])
    await vi.advanceTimersByTimeAsync(20)
    expect(peer.socket.closed).toBe(true)
    expect(seen).toEqual([{ close: 1006, reason: '', wasClean: false }])
  })
})
