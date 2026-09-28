// Type-only shapes for the routed WebSocket (./websocket-frames.ts,
// ./websocket.ts). Both installers are serialised into the main world,
// so, like ./types.ts, nothing here may produce JS.
import type { FetchRouteTarget, ResponseHead, RoutedSlot } from './types.js'

export interface WebSocketRouteTarget extends FetchRouteTarget {
  WebSocket?: unknown
}

/** One whole message or control frame, as the peer sent it. */
export type WebSocketInbound =
  | { readonly kind: 'text', readonly data: string }
  | { readonly kind: 'binary', readonly data: Uint8Array }
  | { readonly kind: 'ping', readonly data: Uint8Array }
  | { readonly kind: 'pong' }
  /** `code` 1005 when the frame carried no status code. */
  | { readonly kind: 'close', readonly code: number, readonly reason: string }

/** The peer broke RFC 6455: fail the connection, sending `code` in the close frame. */
export interface WebSocketProtocolError {
  readonly closeCode: number
  readonly message: string
}

export interface WebSocketInboundParser {
  /** Every complete message and control frame `chunk` finished. Throws a `WebSocketProtocolError`. */
  feed: (chunk: Uint8Array) => WebSocketInbound[]
}

/** ./websocket-frames.ts: the RFC 6455 client codec and the opening handshake. */
export interface WebSocketFrames {
  opcodes: { readonly text: number, readonly binary: number, readonly close: number, readonly ping: number, readonly pong: number }
  /** A whole masked frame, as the pieces it is written in: no piece is a view over a larger buffer. */
  encode: (opcode: number, payload: Uint8Array) => Uint8Array[]
  closePayload: (code: number | undefined, reason: Uint8Array) => Uint8Array
  parser: () => WebSocketInboundParser
  /** A fresh Sec-WebSocket-Key. */
  key: () => string
  /** The negotiated subprotocol, or throws an Error naming why the handshake failed. */
  checkHandshake: (head: ResponseHead, key: string, protocols: readonly string[]) => Promise<string>
}

export interface WebSocketSlot extends RoutedSlot {
  webSocketFrames?: WebSocketFrames
}
