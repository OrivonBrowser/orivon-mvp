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
import type { FileStat, SendRefusal } from '../contracts/handles.js'

/**
 * What orivon-surface.ts's fsOpen bridge closure resolves to (A184) --
 * deliberately narrower than `FileHandle` (contracts/handles.ts): no
 * `readable`/`writable`, and no live-pushed `closed`. Every method here is a
 * plain request/reply CONTROL_CHANNEL round trip -- unlike net.connect,
 * fs.open needs no per-socket port or byte pump, so it needs none of the
 * main-world stream machinery ./main-world-socket.ts's `buildSocket` exists
 * for. See this lane's own PR body for what that means a page cannot do yet.
 *
 * Moved here from ./main-world-socket.ts (A195) so `MainWorldDirectoryBridge`
 * below could reference it without a circular import -- re-exported from
 * there so no existing `from '../main-world-socket.js'` import site needed
 * to change.
 */
export interface MainWorldFileBridge {
  readonly id: string
  read: (opts: { position: number, length: number }) => Promise<Uint8Array>
  write: (opts: { position: number, data: Uint8Array }) => Promise<number>
  stat: () => Promise<FileStat>
  truncate: (length: number) => Promise<void>
  sync: () => Promise<void>
  close: () => Promise<void>
}

/**
 * What orivon-surface.ts's fsUserSelectedDirectory bridge closure resolves
 * to (A195) -- `MainWorldFileBridge`'s own counterpart for `DirectoryHandle`
 * (contracts/handles.ts), same reasoning: every member is a plain
 * request/reply round trip, so this needs no main-world stream machinery
 * either. `open` resolves the SAME raw shape `MainWorldFileBridge` is --
 * `DirectoryHandle.open()` returns a real `FileHandle`, routed through
 * fs.open's existing wire methods (dispatch-fs.ts's own `fs.dirOpen` case),
 * not a second file-handle mechanism.
 */
export interface MainWorldDirectoryBridge {
  readonly id: string
  readdir: (path?: string) => Promise<readonly string[]>
  stat: (path?: string) => Promise<FileStat>
  mkdir: (path: string, opts?: { recursive?: boolean }) => Promise<void>
  rm: (path: string, opts?: { recursive?: boolean }) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  readFile: (path: string) => Promise<Uint8Array>
  writeFile: (path: string, data: Uint8Array) => Promise<void>
  open: (path: string, flags: string) => Promise<MainWorldFileBridge>
  close: () => Promise<void>
}

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
