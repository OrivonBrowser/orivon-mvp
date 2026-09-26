// The server side of RFC 6455, for the routed WebSocket suites: a frame
// encoder, a decoder for what the client wrote, and a fake peer that answers
// the opening handshake over routed.test-helpers.ts's fake socket.
// Not *.test.ts, so vitest does not collect it as its own suite.
import { createHash } from 'node:crypto'
import { installRoutedEvents } from '../events.js'
import { installWebSocketFrames } from '../websocket-frames.js'
import { installWebSocketRoute } from '../websocket.js'
import { bytes, concat, fakeSocket, fakeTarget, installRouted, reserialised, settle } from './routed.test-helpers.js'
import type { FakeSocket } from './routed.test-helpers.js'
import type { FetchRouteSocket } from '../types.js'
import type { WebSocketRouteTarget } from '../websocket-types.js'

export const WS_INSTALLERS = [installRoutedEvents, installWebSocketFrames, installWebSocketRoute].map((fn) => reserialised(fn))

export const OP = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const

/** One server-to-client frame. Unmasked, as RFC 6455 requires of a server, unless `mask` says otherwise. */
export function serverFrame (opcode: number, payload: Uint8Array | string = new Uint8Array(0), opts: { fin?: boolean, mask?: boolean, rsv?: number } = {}): Uint8Array {
  const data = typeof payload === 'string' ? bytes(payload) : payload
  const first = ((opts.fin ?? true) ? 0x80 : 0) | ((opts.rsv ?? 0) << 4) | opcode
  const maskBit = opts.mask === true ? 0x80 : 0
  let head: number[]
  if (data.byteLength < 126) head = [first, maskBit | data.byteLength]
  else if (data.byteLength < 65536) head = [first, maskBit | 126, data.byteLength >> 8, data.byteLength & 0xff]
  else {
    head = [first, maskBit | 127, 0, 0, 0, 0]
    for (let shift = 24; shift >= 0; shift -= 8) head.push((data.byteLength >>> shift) & 0xff)
  }
  if (opts.mask !== true) return concat(new Uint8Array(head), data)
  const key = new Uint8Array([1, 2, 3, 4])
  return concat(new Uint8Array(head), key, data.map((b, i) => b ^ key[i % 4]!))
}

export function closeFrame (code?: number, reason = ''): Uint8Array {
  if (code === undefined) return serverFrame(OP.close)
  return serverFrame(OP.close, concat(new Uint8Array([code >> 8, code & 0xff]), bytes(reason)))
}

export interface ClientFrame {
  readonly fin: boolean
  readonly opcode: number
  readonly masked: boolean
  readonly payload: Uint8Array
}

/** Decodes client frames, unmasking each payload. Throws on a truncated frame. */
export function parseClientFrames (data: Uint8Array): ClientFrame[] {
  const frames: ClientFrame[] = []
  let at = 0
  while (at < data.byteLength) {
    const fin = (data[at]! & 0x80) !== 0
    const opcode = data[at]! & 0x0f
    const masked = (data[at + 1]! & 0x80) !== 0
    let length = data[at + 1]! & 0x7f
    at += 2
    if (length === 126) { length = (data[at]! << 8) | data[at + 1]!; at += 2 } else if (length === 127) {
      length = 0
      for (let i = 0; i < 8; i++) length = length * 256 + data[at + i]!
      at += 8
    }
    const key = masked ? data.subarray(at, at + 4) : new Uint8Array(4)
    if (masked) at += 4
    if (at + length > data.byteLength) throw new Error('truncated client frame')
    const payload = data.slice(at, at + length).map((b, i) => b ^ key[i % 4]!)
    frames.push({ fin, opcode, masked, payload })
    at += length
  }
  return frames
}

export function acceptFor (key: string): string {
  return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
}

export interface FakeWsPeer {
  readonly socket: FakeSocket
  /** The client's request head, as text. */
  readonly request: string
  header: (name: string) => string | undefined
  /** Every frame the client wrote after its request head, unmasked. */
  frames: () => ClientFrame[]
  /** Answers the handshake: 101 with a correct accept, unless `head` replaces the whole response head. */
  accept: (opts?: { protocol?: string, extraHeaders?: string, head?: string, then?: Uint8Array }) => void
}

export function fakeWsPeer (): FakeWsPeer {
  const socket = fakeSocket([], true)
  const all = (): Uint8Array => concat(...socket.written)
  const headLength = (): number => {
    const text = new TextDecoder('latin1').decode(all())
    const end = text.indexOf('\r\n\r\n')
    return end === -1 ? -1 : end + 4
  }
  const peer: FakeWsPeer = {
    socket,
    get request () {
      const end = headLength()
      return end === -1 ? '' : new TextDecoder('latin1').decode(all().subarray(0, end))
    },
    header (name) {
      const line = peer.request.split('\r\n').find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))
      return line === undefined ? undefined : line.slice(line.indexOf(':') + 1).trim()
    },
    frames: () => parseClientFrames(all().subarray(Math.max(0, headLength()))),
    accept (opts = {}) {
      const key = peer.header('sec-websocket-key') ?? ''
      const head = opts.head ?? [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptFor(key)}`,
        ...(opts.protocol !== undefined ? [`Sec-WebSocket-Protocol: ${opts.protocol}`] : []),
        ...(opts.extraHeaders !== undefined ? [opts.extraHeaders] : [])
      ].join('\r\n')
      socket.push(concat(bytes(`${head}\r\n\r\n`), opts.then ?? new Uint8Array(0)))
    }
  }
  return peer
}

/** A page window with the routed WebSocket installed; every dial hands out the next peer from `peers`. */
export function wsTarget (opts: {
  peers?: FakeWsPeer[]
  dial?: (o: { host: string, port: number }, secure: boolean) => Promise<FetchRouteSocket>
  nativeWebSocket?: unknown
  location?: { origin: string, href: string }
} = {}): WebSocketRouteTarget & { WebSocket: typeof WebSocket } {
  const peers = opts.peers ?? []
  const dial = opts.dial ?? (async () => {
    const peer = peers.shift()
    if (peer === undefined) throw new Error('unexpected dial')
    return peer.socket
  })
  const target = fakeTarget({
    connect: async (o) => await dial(o, false),
    connectSecure: async (o) => await dial(o, true),
    location: opts.location ?? { origin: 'https://app.example', href: 'https://app.example/index.html' },
    userAgent: 'TestAgent/1.0'
  }) as WebSocketRouteTarget & { WebSocket: typeof WebSocket }
  target.WebSocket = (opts.nativeWebSocket ?? FakeNativeWebSocket) as typeof WebSocket
  installRouted(target, WS_INSTALLERS)
  return target
}

/** Lets a handshake answer be judged. The accept check is a real crypto.subtle digest, which no fixed number of turns is sure to outlast. */
export async function settleHandshake (ws: WebSocket): Promise<void> {
  for (let i = 0; i < 100 && ws.readyState === 0; i++) await settle()
  await settle()
}

/** Opens a routed socket on `peer` and completes the handshake. */
export async function openSocket (peer = fakeWsPeer(), url = 'wss://feed.example/live', protocols?: string | string[]): Promise<{ ws: WebSocket, peer: FakeWsPeer, target: ReturnType<typeof wsTarget> }> {
  const target = wsTarget({ peers: [peer] })
  const ws = new target.WebSocket(url, protocols)
  await settle()
  peer.accept(typeof protocols === 'string' ? { protocol: protocols } : {})
  await settleHandshake(ws)
  if (ws.readyState !== 1) throw new Error(`the socket did not open (readyState ${ws.readyState})`)
  return { ws, peer, target }
}

/** Everything a socket dispatched, in order, with the fields each event type carries. */
export function recordEvents (ws: WebSocket): unknown[] {
  const seen: unknown[] = []
  ws.addEventListener('open', () => { seen.push('open') })
  ws.addEventListener('error', () => { seen.push('error') })
  ws.addEventListener('message', (e) => { seen.push({ message: e.data as unknown }) })
  ws.addEventListener('close', (e) => { seen.push({ close: e.code, reason: e.reason, wasClean: e.wasClean }) })
  return seen
}

/** A recording stand-in for the page's native WebSocket. */
export class FakeNativeWebSocket extends EventTarget {
  static last: FakeNativeWebSocket | undefined
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly calls: unknown[][] = []
  readyState = 0
  bufferedAmount = 0
  binaryType = 'blob'
  protocol = ''
  extensions = ''
  constructor (readonly url: string, readonly protocols?: string | string[]) { super(); FakeNativeWebSocket.last = this }
  send (data: unknown): void { this.calls.push(['send', data]) }
  close (code?: number, reason?: string): void { this.calls.push(['close', code, reason]); this.readyState = 2 }
}

export { settle }
