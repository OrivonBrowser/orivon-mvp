// Type-only shapes for ./main-world-socket.ts's `installOrivon` bridge
// argument (MainWorldBridge, below) and its own members' return values (the
// rest of this file). Split out under code-guidelines.md Rule 2 -- by
// concern (this is "what crosses the bridge", separate from "how a real
// WHATWG stream is built over it", which that file still owns), not by line
// count. MainWorldBridge itself moved out of installOrivon's own signature
// for the identical reason (A178's precedent: continue an existing split
// seam rather than cut a file arbitrarily) -- installOrivon's parameter list
// carried this whole shape inline, which is most of what pushed that file to
// Rule 2's 500-line ceiling.
//
// SAFE DESPITE installOrivon's OWN SERIALISED-FUNCTION CONSTRAINT (that
// file's own header: every helper `installOrivon` needs must be declared
// INSIDE its body, because `Function.prototype.toString()` only captures its
// compiled JS, not anything it imports). None of that applies here:
// TypeScript erases every interface below entirely before compilation --
// there is no JS output for an `interface` at all -- so nothing in this file
// ever reaches the main world; only installOrivon's own compiled body does.

import type { OrivonErrorCode } from '../contracts/errors.js'
import type { FileStat, LookupAddress, SecureHandshake, SendRefusal } from '../contracts/handles.js'
import type { CapabilityRequest, SecureConnectOptions } from '../contracts/capability-api.js'
import type { ResponseEnvelope } from '../contracts/ipc.js'

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
 * What ./web-surface.ts's webOpenContext bridge closure resolves to
 * (ADR-0019) -- `MainWorldFileBridge`'s own sibling: no `readable`/
 * `writable`, no native stream machinery, because every member here is a
 * plain request/reply CONTROL_CHANNEL round trip, `web.evaluate`/`web.close`
 * included. `closed` is a REAL, live-settling promise despite that -- see
 * ./web-surface.ts's own header for the `web.awaitClose` long-poll it is
 * built from.
 */
export interface MainWorldWebContextBridge {
  readonly id: string
  readonly origin: string
  readonly closed: Promise<void>
  evaluate: (script: string, options?: { readonly timeoutMs?: number }) => Promise<unknown>
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
  readonly onReadEnd: (cb: (code: OrivonErrorCode | undefined, platformCode?: string) => void) => void
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
  readonly onReadEnd: (cb: (code: OrivonErrorCode | undefined, platformCode?: string) => void) => void
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
  readonly onReadEnd: (cb: (code: OrivonErrorCode | undefined, platformCode?: string) => void) => void
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
  /** A `net.connectSecure` socket's handshake facts, plain data from the broker's reply; absent on every other socket. */
  readonly tls?: SecureHandshake
}

/**
 * The full shape `orivon-surface.ts` passes as installOrivon's `bridge`
 * argument -- one plain proxied closure per orivon.* method that needs a
 * main-world build step, each wrapped exactly once (`./main-world-socket.ts`'s
 * own `buildSocket`/`buildFile`/`buildWebContext`/`buildUdpSocket`/
 * `buildServer`/`buildDirectory`, or called directly for the methods that
 * need no such wrapping). Moved here from installOrivon's own signature --
 * see this file's own header.
 */
export interface MainWorldBridge {
  appManifest: () => Promise<unknown>
  appGrants: () => Promise<unknown>
  appRequestGrant: (request: CapabilityRequest) => Promise<boolean>
  fsReadFile: (path: string) => Promise<Uint8Array>
  fsWriteFile: (path: string, data: Uint8Array) => Promise<void>
  /**
   * ADR-0016's one synchronous call. Returns the raw envelope, NEVER
   * throws -- a value THROWN by this closure would cross the
   * contextBridge proxy boundary back into this main-world code stripped
   * of everything but `.message` (found live; see orivon-surface.ts's own
   * `fsReadFileSyncEnvelope` for the full argument), so the failure shape
   * is built and thrown by `./main-world-socket.ts`'s own `installOrivon`,
   * entirely inside that already-main-world function, from data that
   * crossed intact instead.
   */
  fsReadFileSync: (path: string) => ResponseEnvelope<Uint8Array>
  // The extended fs surface (queue item 2.1) -- no main-world stream
  // wrapping needed, exactly like fsReadFile/fsWriteFile above, so these
  // four are plain proxied closures too.
  fsMkdir: (path: string, opts?: { recursive?: boolean }) => Promise<void>
  fsReaddir: (path: string) => Promise<readonly string[]>
  fsStat: (path: string) => Promise<FileStat>
  fsRm: (path: string, opts?: { recursive?: boolean }) => Promise<void>
  fsRename: (from: string, to: string) => Promise<void>
  /**
   * Resolves to a `MainWorldFileBridge` -- itself a plain object of MORE
   * proxied closures (read/write/stat/truncate/sync/close), each its own
   * round trip. Needs no main-world stream wrapping, same reasoning as
   * fsMkdir/fsReaddir/etc. above; `./main-world-socket.ts`'s own `buildFile`
   * still wraps each nested closure in `callRevived`, because EVERY one of
   * them crosses back into the isolated world independently and could reject.
   */
  fsOpen: (path: string, flags: string) => Promise<MainWorldFileBridge>
  /** `orivon.fs.userSelected`'s FILE shape (A194, d-0032). `installOrivon`'s own `api.fs.userSelected` routes here for every call except `{ directory: true }`. Resolves the same raw `MainWorldFileBridge` shape `fsOpen` does; `buildFile` wraps each entry. */
  fsUserSelected: (opts?: { multiple?: boolean }) => Promise<readonly MainWorldFileBridge[]>
  /** `orivon.fs.userSelected`'s FOLDER shape (A195) -- a separate closure, not a widened `fsUserSelected`, since the two resolve genuinely different shapes (capability-api.ts's own overload split). `buildDirectory` is this one's `buildFile`. */
  fsUserSelectedDirectory: () => Promise<MainWorldDirectoryBridge | null>
  idPublicKey: (curve: string) => Promise<Uint8Array>
  idSign: (curve: string, payload: Uint8Array) => Promise<Uint8Array>
  /** ADR-0031: plain request/reply, exactly `idPublicKey`/`idSign`'s own shape -- no main-world stream wrapping needed. */
  secretsAvailable: () => Promise<boolean>
  secretsEncrypt: (plaintext: Uint8Array) => Promise<Uint8Array>
  secretsDecrypt: (ciphertext: Uint8Array) => Promise<Uint8Array>
  /** ADR-0019 -- resolves a `MainWorldWebContextBridge`, `fsOpen`'s own shape of counterpart (a plain object of MORE proxied closures, no native stream). `./main-world-socket.ts`'s own `buildWebContext` wraps it the same way `buildFile` wraps `fsOpen`'s. Takes `origin` folded into `opts`, unlike the public `openContext(origin, options?)` two-argument shape `installOrivon` builds, which merges them back in before calling this. */
  webOpenContext: (opts: { origin: string, width?: number, height?: number }) => Promise<MainWorldWebContextBridge>
  netConnect: (opts: { host: string, port: number }) => Promise<MainWorldSocketBridge>
  /** net.connectSecure's own closure -- resolves to netConnect's bridge shape plus `tls`; `./main-world-socket.ts`'s own `buildSocket` is shared by both (Rule 3). The options pass through untouched: the broker validates them. */
  netConnectSecure: (opts: SecureConnectOptions) => Promise<MainWorldSocketBridge>
  netUdpBind: (opts: { port: number }) => Promise<MainWorldUdpBridge>
  netListen: (opts: { port: number }) => Promise<MainWorldServerBridge>
  /** `net.lookup` (d-0030) -- plain data, not a bridge: no per-socket state to wrap, unlike every other `net*` entry above. */
  netLookup: (opts: { hostname: string }) => Promise<readonly LookupAddress[]>
}
