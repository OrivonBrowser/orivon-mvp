// The routed WebSocket, re-evaluated from its own source and run against a
// fake orivon.net peer speaking the server side of RFC 6455
// (websocket-route.test-helpers.ts): the constructor, the opening handshake,
// and the native path for everything the routed one does not take.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bytes, refusal, reserialised } from './routed.test-helpers.js'
import { acceptFor, FakeNativeWebSocket, fakeWsPeer, openSocket, recordEvents, serverFrame, OP, settle, settleHandshake, WS_INSTALLERS, wsTarget } from './websocket-route.test-helpers.js'
import { WEBSOCKET_OPENING_TIMEOUT_MS } from '../websocket-route.js'
import { installRoutedWire } from '../routed-wire.js'
import { installWebSocketFrames } from '../websocket-route-frames.js'
import type { ResponseHead } from '../fetch-route-types.js'
import type { WebSocketSlot } from '../websocket-route-types.js'

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('routed WebSocket -- the global', () => {
  it('is installed with an interface object\'s descriptor and the platform\'s constants', () => {
    const target = wsTarget()
    const descriptor = Object.getOwnPropertyDescriptor(target, 'WebSocket')
    expect([descriptor?.writable, descriptor?.configurable, descriptor?.enumerable]).toEqual([true, true, false])
    const WS = target.WebSocket
    expect([WS.CONNECTING, WS.OPEN, WS.CLOSING, WS.CLOSED]).toEqual([0, 1, 2, 3])
    expect(WS).not.toBe(FakeNativeWebSocket)
  })

  it('is not installed outside an app tab', () => {
    const target = { WebSocket: FakeNativeWebSocket }
    for (const install of WS_INSTALLERS) install(false, target)
    expect(target.WebSocket).toBe(FakeNativeWebSocket)
  })
})

describe('routed WebSocket -- the constructor', () => {
  it('throws SyntaxError for an unparsable URL, a non-WebSocket scheme, or a fragment', () => {
    const { WebSocket: WS } = wsTarget()
    for (const url of ['http://[bad', 'ftp://feed.example/', 'wss://feed.example/#frag', 'wss://feed.example/#']) {
      expect(() => new WS(url), url).toThrow(expect.objectContaining({ name: 'SyntaxError' }) as Error)
    }
  })

  it('throws SyntaxError for a duplicated or malformed subprotocol', () => {
    const { WebSocket: WS } = wsTarget()
    for (const protocols of [['chat', 'chat'], ['bad token'], [''], ['caf\u00e9']]) {
      expect(() => new WS('wss://feed.example/', protocols), JSON.stringify(protocols)).toThrow(expect.objectContaining({ name: 'SyntaxError' }) as Error)
    }
  })

  it('turns http(s) into ws(s) and resolves a relative URL against the page', async () => {
    const dials: Array<[string, number, boolean]> = []
    const target = wsTarget({ dial: async (o, secure) => { dials.push([o.host, o.port, secure]); throw refusal('denied') } })
    const secure = new target.WebSocket('https://feed.example/a?b=1')
    const plain = new target.WebSocket('http://feed.example:8080/')
    expect([secure.url, plain.url]).toEqual(['wss://feed.example/a?b=1', 'ws://feed.example:8080/'])
    await settle()
    expect(dials).toEqual([['feed.example', 443, true], ['feed.example', 8080, false]])
  })

  it('starts CONNECTING, with send() refused as the platform refuses it', () => {
    const { WebSocket: WS } = wsTarget({ dial: async () => await new Promise(() => {}) })
    const ws = new WS('wss://feed.example/')
    expect([ws.readyState, ws.bufferedAmount, ws.protocol, ws.extensions, ws.binaryType]).toEqual([0, 0, '', '', 'blob'])
    expect(() => { ws.send('x') }).toThrow(expect.objectContaining({ name: 'InvalidStateError' }) as Error)
    ws.binaryType = 'nonsense' as BinaryType
    expect(ws.binaryType).toBe('blob')
    ws.binaryType = 'arraybuffer'
    expect(ws.binaryType).toBe('arraybuffer')
  })
})

describe('routed WebSocket -- the opening handshake', () => {
  it('checks the accept key against RFC 6455\'s own worked example, not only against this suite\'s server', async () => {
    const target = {}
    for (const install of [installRoutedWire, installWebSocketFrames].map((fn) => reserialised(fn))) install(true, target)
    const frames = (target as Record<symbol, WebSocketSlot>)[Symbol.for('orivon.routed-network')]!.webSocketFrames!
    const head = (accept: string): ResponseHead => ({
      status: 101, statusText: 'Switching Protocols', rest: new Uint8Array(0),
      headers: [['Upgrade', 'websocket'], ['Connection', 'Upgrade'], ['Sec-WebSocket-Accept', accept]]
    })
    // RFC 6455 section 1.3.
    expect(acceptFor('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
    await expect(frames.checkHandshake(head('s3pPLMBiTxaQ9kYGzzhZRbK+xOo='), 'dGhlIHNhbXBsZSBub25jZQ==', [])).resolves.toBe('')
    await expect(frames.checkHandshake(head('s3pPLMBiTxaQ9kYGzzhZRbK+xOp='), 'dGhlIHNhbXBsZSBub25jZQ==', [])).rejects.toThrow('Incorrect')
  })

  it('sends an RFC 6455 upgrade carrying the page origin, the subprotocols and no extensions', async () => {
    const peer = fakeWsPeer()
    const target = wsTarget({ peers: [peer] })
    const ws = new target.WebSocket('wss://feed.example/live?x=1', ['chat', 'superchat'])
    await settle()
    expect(peer.request.split('\r\n')[0]).toBe('GET /live?x=1 HTTP/1.1')
    expect(peer.header('host')).toBe('feed.example')
    expect(peer.header('upgrade')).toBe('websocket')
    expect(peer.header('connection')).toBe('Upgrade')
    expect(peer.header('sec-websocket-version')).toBe('13')
    expect(peer.header('origin')).toBe('https://app.example')
    expect(peer.header('sec-websocket-protocol')).toBe('chat, superchat')
    expect(peer.header('user-agent')).toBe('TestAgent/1.0')
    expect(peer.header('sec-websocket-extensions')).toBeUndefined()
    expect(Buffer.from(peer.header('sec-websocket-key') ?? '', 'base64')).toHaveLength(16)
    expect(ws.readyState).toBe(0)
  })

  it('opens once the accept key checks out, taking the subprotocol the server chose', async () => {
    const peer = fakeWsPeer()
    const target = wsTarget({ peers: [peer] })
    const ws = new target.WebSocket('wss://feed.example/', ['chat', 'superchat'])
    const seen = recordEvents(ws)
    let viaHandler = 0
    ws.onopen = () => { viaHandler++ }
    await settle()
    peer.accept({ protocol: 'superchat' })
    await settleHandshake(ws)
    expect(seen).toEqual(['open'])
    expect([viaHandler, ws.readyState, ws.protocol, ws.extensions]).toEqual([1, 1, 'superchat', ''])
  })

  it('delivers frames that arrive in the same chunk as the 101 head, after open', async () => {
    const peer = fakeWsPeer()
    const target = wsTarget({ peers: [peer] })
    const ws = new target.WebSocket('wss://feed.example/')
    const seen = recordEvents(ws)
    await settle()
    peer.accept({ then: serverFrame(OP.text, 'first') })
    await settleHandshake(ws)
    expect(seen).toEqual(['open', { message: 'first' }])
  })

  const failures: Array<[string, (key: string) => string]> = [
    ['a wrong accept key', () => 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: bm90IHRoZSBrZXk='],
    ['a redirect', () => 'HTTP/1.1 302 Found\r\nLocation: wss://elsewhere.example/\r\nContent-Length: 0'],
    ['a plain 200', () => 'HTTP/1.1 200 OK\r\nContent-Length: 0'],
    ['no Upgrade header', (key) => `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptFor(key)}`],
    ['no upgrade token in Connection', (key) => `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: keep-alive\r\nSec-WebSocket-Accept: ${acceptFor(key)}`],
    ['an extension the client never offered', (key) => `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptFor(key)}\r\nSec-WebSocket-Extensions: permessage-deflate`],
    ['a subprotocol the client never offered', (key) => `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptFor(key)}\r\nSec-WebSocket-Protocol: other`],
    ['two accept headers', (key) => `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptFor(key)}\r\nSec-WebSocket-Accept: ${acceptFor(key)}`]
  ]
  for (const [what, head] of failures) {
    it(`fails on ${what}: error, then close 1006, and the socket is released`, async () => {
      let dials = 0
      const peer = fakeWsPeer()
      const target = wsTarget({ dial: async () => { dials++; return peer.socket } })
      const ws = new target.WebSocket('wss://feed.example/')
      const seen = recordEvents(ws)
      await settle()
      peer.accept({ head: head(peer.header('sec-websocket-key') ?? '') })
      await settleHandshake(ws)
      expect(seen).toEqual(['error', { close: 1006, reason: '', wasClean: false }])
      expect([ws.readyState, peer.socket.closed, dials]).toEqual([3, true, 1])
    })
  }

  it('fails when the client offered subprotocols and the server chose none', async () => {
    const peer = fakeWsPeer()
    const target = wsTarget({ peers: [peer] })
    const ws = new target.WebSocket('wss://feed.example/', 'chat')
    const seen = recordEvents(ws)
    await settle()
    peer.accept()
    await settleHandshake(ws)
    expect(seen).toEqual(['error', { close: 1006, reason: '', wasClean: false }])
  })

  it('fails when the connection closes before the handshake completes', async () => {
    const peer = fakeWsPeer()
    const target = wsTarget({ peers: [peer] })
    const ws = new target.WebSocket('wss://feed.example/')
    const seen = recordEvents(ws)
    await settle()
    peer.socket.end()
    await settle()
    expect(seen).toEqual(['error', { close: 1006, reason: '', wasClean: false }])
  })

  it('gives up on a server that never answers the upgrade', async () => {
    vi.useFakeTimers()
    const peer = fakeWsPeer()
    const target = wsTarget({ peers: [peer] })
    const ws = new target.WebSocket('wss://feed.example/')
    const seen = recordEvents(ws)
    await vi.advanceTimersByTimeAsync(WEBSOCKET_OPENING_TIMEOUT_MS - 10)
    expect(seen).toEqual([])
    await vi.advanceTimersByTimeAsync(20)
    expect(seen).toEqual(['error', { close: 1006, reason: '', wasClean: false }])
    expect(peer.socket.closed).toBe(true)
  })

  it('close() while connecting fails the connection: CLOSING at once, then error and close 1006', async () => {
    const peer = fakeWsPeer()
    const target = wsTarget({ peers: [peer] })
    const ws = new target.WebSocket('wss://feed.example/')
    const seen = recordEvents(ws)
    const viaHandlers: string[] = []
    ws.onerror = () => { viaHandlers.push('onerror') }
    ws.onclose = (e: CloseEvent) => { viaHandlers.push(`onclose ${e.code}`) }
    await settle()
    ws.close()
    expect(ws.readyState).toBe(2)
    await settle()
    expect(seen).toEqual(['error', { close: 1006, reason: '', wasClean: false }])
    expect(viaHandlers).toEqual(['onerror', 'onclose 1006'])
    expect([ws.readyState, peer.socket.closed]).toEqual([3, true])
  })

  it('waits in the dial queue when the origin\'s socket allowance is spent', async () => {
    vi.useFakeTimers()
    const peer = fakeWsPeer()
    let refusals = 1
    const target = wsTarget({ dial: async () => { if (refusals-- > 0) throw refusal('limit'); return peer.socket } })
    const ws = new target.WebSocket('wss://feed.example/')
    await vi.advanceTimersByTimeAsync(10)
    expect(peer.request).toBe('')
    await vi.advanceTimersByTimeAsync(600)
    expect(peer.request).toContain('Upgrade: websocket')
    expect(ws.readyState).toBe(0)
  })
})

describe('routed WebSocket -- the native path', () => {
  it('hands a host the app was not granted to the native WebSocket, forwarding its events', async () => {
    const target = wsTarget({ dial: async () => { throw refusal('denied') } })
    const ws = new target.WebSocket('wss://not-granted.example/feed', ['chat'])
    ws.binaryType = 'arraybuffer'
    const seen = recordEvents(ws)
    await settle()
    const native = FakeNativeWebSocket.last!
    expect([native.url, native.protocols, native.binaryType]).toEqual(['wss://not-granted.example/feed', ['chat'], 'arraybuffer'])
    Object.assign(native, { readyState: 1, protocol: 'chat', bufferedAmount: 7 })
    native.dispatchEvent(new Event('open'))
    native.dispatchEvent(new MessageEvent('message', { data: 'hi', origin: 'wss://not-granted.example' }))
    expect([ws.readyState, ws.protocol, ws.bufferedAmount]).toEqual([1, 'chat', 7])
    ws.send('out')
    ws.binaryType = 'blob'
    ws.close(4000, 'bye')
    native.dispatchEvent(new CloseEvent('close', { code: 4000, reason: 'bye', wasClean: true }))
    expect(native.calls).toEqual([['send', 'out'], ['close', 4000, 'bye']])
    expect(native.binaryType).toBe('blob')
    expect(seen).toEqual(['open', { message: 'hi' }, { close: 4000, reason: 'bye', wasClean: true }])
  })

  it('opens a same-origin socket natively, straight away, with no dial', () => {
    let dials = 0
    const target = wsTarget({ dial: async () => { dials++; throw refusal('denied') } })
    const ws = new target.WebSocket('/hmr')
    expect(FakeNativeWebSocket.last!.url).toBe('wss://app.example/hmr')
    expect([ws.url, dials]).toEqual(['wss://app.example/hmr', 0])
  })

  it('reports a native constructor that throws after the grant answered as a failed connection', async () => {
    class ThrowingNative { constructor () { throw new DOMException('insecure', 'SecurityError') } }
    const target = wsTarget({ dial: async () => { throw refusal('denied') }, nativeWebSocket: ThrowingNative })
    const ws = new target.WebSocket('ws://not-granted.example/')
    const seen = recordEvents(ws)
    await settle()
    expect(seen).toEqual(['error', { close: 1006, reason: '', wasClean: false }])
  })

  it('fails like a network error when the dial fails for any other reason', async () => {
    const target = wsTarget({ dial: async () => { throw Object.assign(refusal('network'), { platformCode: 'ECONNREFUSED' }) } })
    const ws = new target.WebSocket('wss://down.example/')
    const seen = recordEvents(ws)
    await settle()
    expect(seen).toEqual(['error', { close: 1006, reason: '', wasClean: false }])
    expect(FakeNativeWebSocket.last?.url).not.toBe('wss://down.example/')
  })
})

describe('routed WebSocket -- a whole routed session', () => {
  it('round-trips a text message over a granted host', async () => {
    const { ws, peer } = await openSocket()
    const seen = recordEvents(ws)
    ws.send('ping?')
    await settle()
    expect(peer.frames().map((f) => [f.opcode, new TextDecoder().decode(f.payload), f.masked])).toEqual([[OP.text, 'ping?', true]])
    peer.socket.push(serverFrame(OP.text, bytes('pong!')))
    await settle()
    expect(seen).toEqual([{ message: 'pong!' }])
  })
})
