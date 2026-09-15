// Type-only shapes for ./main-world-socket.ts's `installOrivon` bridge
// argument and its own return values. Split out under code-guidelines.md
// Rule 2 -- by concern (this is "what crosses the bridge", separate from
// "how a real WHATWG stream is built over it", which that file still owns),
// not by line count.
//
// SAFE DESPITE installOrivon's OWN SERIALISED-FUNCTION CONSTRAINT (that
// file's own header: every helper `installOrivon` needs must be declared
// INSIDE its body, because `Function.prototype.toString()` only captures its
// compiled JS, not anything it imports). None of that applies here:
// TypeScript erases every interface below entirely before compilation --
// there is no JS output for an `interface` at all -- so nothing in this file
// ever reaches the main world; only installOrivon's own compiled body does.

import type { OrivonErrorCode } from '../contracts/errors.js'
import type { SendRefusal } from '../contracts/handles.js'

export interface OrivonLimits {
  readonly readWindowBytes: number
  readonly writeWindowBytes: number
  readonly inboundDatagramWindow: number
  readonly outboundDatagramWindow: number
}

/** One UDP packet, as the page sees it. Mirrors contracts/handles.ts's Datagram. */
export interface MainWorldDatagram {
  readonly data: Uint8Array
  readonly address: string
  readonly port: number
  readonly family: 'IPv4' | 'IPv6'
}

/**
 * What orivon-surface.ts's netUdpBind closure resolves to -- ./datagram-port.ts's
 * DatagramPort plus the bind descriptor and the one control-channel operation
 * a UDP socket has (close).
 *
 * `onDropped` is PUSH-BASED rather than a pair of getters, and that is not a
 * style choice: a value returned synchronously across contextBridge's proxy is
 * unproven on this path, while sync-void calls with callbacks are exactly what
 * the rest of this bridge already does and what the 2026-09-05 probe confirmed.
 */
export interface MainWorldUdpBridge {
  readonly id: string
  readonly localAddress: string
  readonly localPort: number
  readonly onDatagram: (cb: (datagram: MainWorldDatagram) => void) => void
  readonly onReadEnd: (cb: (code: OrivonErrorCode | undefined) => void) => void
  readonly onDropped: (cb: (inbound: number, outbound: number) => void) => void
  /** Fires once per refused outbound datagram (A87), feeding buildUdpSocket's `refusals` stream. */
  readonly onRefusal: (cb: (refusal: SendRefusal) => void) => void
  readonly onFatal: (cb: (code: OrivonErrorCode) => void) => void
  readonly reportConsumed: (datagrams: number, bytes: number) => void
  readonly send: (datagram: MainWorldDatagram) => Promise<void>
  readonly closed: Promise<void>
  readonly close: () => Promise<void>
}

/**
 * What orivon-surface.ts's netListen closure resolves to -- ./server-port.ts's
 * ServerPort plus the listen descriptor and the one control-channel operation
 * a TcpServer has (close).
 *
 * `onConnection` is PUSH-BASED, matching `MainWorldUdpBridge.onDatagram`'s own
 * reasoning above: a value returned synchronously across contextBridge's
 * proxy is unproven on this path, while a callback registered once and
 * invoked repeatedly is exactly what the 2026-09-05 probe confirmed and what
 * the rest of this bridge already does.
 */
export interface MainWorldServerBridge {
  readonly id: string
  readonly localAddress: string
  readonly localPort: number
  readonly onConnection: (cb: (socket: MainWorldSocketBridge) => void) => void
  readonly onReadEnd: (cb: (code: OrivonErrorCode | undefined) => void) => void
  /** One unit of accept demand -- called ONLY from ./main-world-socket.ts's own buildServer `pull()`; see that file's header and open-questions.md A185. */
  readonly reportAccepted: () => void
  readonly closed: Promise<void>
  readonly close: () => Promise<void>
}

/** The shape ./socket-port.ts's SocketPort plus a connection descriptor and the three control-channel operations net.connect doesn't otherwise expose -- what orivon-surface.ts's netConnect bridge closure resolves to. Also what one accepted connection's own bridge is shaped as (orivon-surface.ts's buildAcceptedBridge) -- an accepted socket and a dialled one are the same thing once accepted. */
export interface MainWorldSocketBridge {
  readonly id: string
  readonly remoteAddress: string
  readonly remotePort: number
  readonly localAddress: string
  readonly localPort: number
  readonly onData: (cb: (chunk: Uint8Array) => void) => void
  readonly onReadEnd: (cb: (code: OrivonErrorCode | undefined) => void) => void
  readonly reportConsumed: (bytesConsumed: number) => void
  readonly write: (chunk: Uint8Array) => Promise<void>
  readonly endWrite: () => Promise<void>
  readonly abortWrite: () => void
  /** Fires once if the write direction fails outright, or the port goes silent past the timeout -- see ./socket-port.ts's own SocketPort.onFatal. */
  readonly onFatal: (cb: (code: OrivonErrorCode) => void) => void
  readonly closed: Promise<void>
  readonly close: () => Promise<void>
  readonly setNoDelay: (on: boolean) => Promise<void>
  readonly setKeepAlive: (on: boolean, initialDelayMs?: number) => Promise<void>
}
