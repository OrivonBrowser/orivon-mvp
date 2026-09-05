// Types for net.connect/net.close's transport dependencies. Split out of
// ./ipc.ts under code-guidelines.md Rule 2 (by concern -- this is one
// question, "what does the byte pump's transport layer need?" -- not by
// line count), the same way ./ipc-validation.ts already split off untrusted-
// input checks. No logic here, only shapes; ./ipc.ts still owns dispatch(),
// registerBrokerIpc and the real MessageChannelMain/WebFrameMain wiring.

import type { SenderFrameLike } from './policy/origin.js'
import type { PortRegistry } from './port-registry.js'
import type { BrokerToRendererMessage } from '../contracts/index.js'

/**
 * What `orivon.net.connect` resolves to over CONTROL_CHANNEL. Deliberately
 * NOT a `TcpSocket`: `readable`, `writable`, `close` and `closed` do not
 * survive structured clone, and the actual bytes travel over the port
 * PORT_CHANNEL delivers separately, tagged with this same `id`.
 */
export interface SocketDescriptor {
  readonly id: string
  readonly remoteAddress: string
  readonly remotePort: number
  readonly localAddress: string
  readonly localPort: number
}

/**
 * The shape of a real `MessagePortMain` this module needs, structurally --
 * a fake stands in for it in tests the same way `SenderFrameLike` lets a
 * literal stand in for `WebFrameMain`.
 */
export interface PortLike {
  postMessage: (message: BrokerToRendererMessage) => void
  onMessage: (listener: (message: unknown) => void) => void
  close: () => void
}

/** `port1` (kept in ./ipc.ts, wired to the pump) and `port2` (handed to the calling frame's PORT_CHANNEL delivery). */
export interface PortPair {
  readonly port1: PortLike
  readonly port2: unknown
}

/**
 * What `net.close` and `./socket-relay.ts`'s registry entry need beyond the
 * raw socket: enough to release it and to answer the two operations
 * declared on `TcpSocket` (`handles.ts`) but not yet wired as their own
 * control methods -- `setNoDelay`/`setKeepAlive` dispatch through this same
 * per-origin lookup, the same ownership check `close` already relies on
 * (T11c: a handle id from one origin means nothing presented by another).
 */
export interface RegisteredSocket {
  readonly close: () => Promise<void>
  readonly setNoDelay: (on: boolean) => Promise<void>
  readonly setKeepAlive: (on: boolean, initialDelayMs?: number) => Promise<void>
}

/**
 * Everything net.connect/net.close need beyond `broker` itself: a way to
 * mint a real port pair, and the per-origin registry (./port-registry.js)
 * a later net.close call looks a live socket up in. ONE instance lives for
 * the subsystem's whole lifetime (registerBrokerIpc creates it once); every
 * `dispatch` call shares it.
 */
export interface PortTransport {
  readonly createPortPair: () => PortPair
  readonly registry: PortRegistry<RegisteredSocket>
}

/**
 * The shape of Electron's `IpcMainInvokeEvent` ./ipc.ts reads: `senderFrame`,
 * widened with the one extra capability net.connect needs -- `postMessage`,
 * to deliver PORT_CHANNEL's port to the SAME frame the request came from. A
 * real `WebFrameMain` satisfies this with room to spare; `SenderFrameLike`
 * (policy/origin.ts) alone would not, which is why this type lives here
 * rather than being reused unwidened.
 */
export interface PortDeliveryFrame extends SenderFrameLike {
  // Method shorthand, not a `postMessage: (...) => void` property -- this is
  // what makes a real WebFrameMain (whose own transfer parameter is the
  // narrower MessagePortMain[]) assignable here. TypeScript checks method-
  // shorthand signatures bivariantly; arrow-typed properties are checked
  // strictly contravariant and would reject it.
  postMessage (channel: string, message: unknown, transfer?: unknown[]): void
}
