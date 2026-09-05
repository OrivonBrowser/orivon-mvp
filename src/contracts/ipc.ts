// The renderer <-> main message shapes.
//
// Control operations (open, close, options) use normal Electron IPC; BULK
// BYTES use a dedicated MessageChannelMain port per handle, because
// per-message IPC is too slow for torrent-rate data
// (capability-api.md SSThroughput).
//
// SECURITY RULE, NOT AN OPTIMISATION DETAIL: the raw port NEVER crosses into
// the main world. The preload holds it in the isolated world and exposes only
// contextBridge closures over it. Transferring the port to the page -- the
// obvious move when optimising for throughput -- hands a raw socket to
// anything the page can reach (security-model.md T17). contextIsolation: true
// is what makes this free.
//
// TWO RULES FROM SPIKE GATE 0, both binding per handle-contracts.md
// SSWhat the shim must do:
//
//   1. NO TRANSFERABLES ON THE RENDERER -> MAIN PATH, EVER, as an optimisation
//      or otherwise. electron#34905 reproduces and is worse than reported:
//      passing an ArrayBuffer in a postMessage transfer list renderer -> main
//      DOES NOT THROW AND NEVER ARRIVES. Silent total loss at every size
//      tested. Structured clone is the only mechanism on this path, and it is
//      already sufficient -- 313-1134 MB/s measured against a 1-5 MB/s product
//      need.
//
//   2. EVERY REPLY-CARRYING MESSAGE NEEDS AN EXPLICIT TIMEOUT, because this
//      transport's failure mode is SILENCE, not an error. A promise awaiting a
//      reply with no timeout hangs forever on exactly this failure -- the
//      first spike run did. `timeoutMs` below is therefore a required field
//      rather than an optional one: the type system is a cheaper place to
//      enforce this than a code review that has to remember it.

import type { OrivonErrorCode } from './errors.js'

/**
 * Every request that expects a reply. `timeoutMs` is REQUIRED -- see rule 2
 * above. There is deliberately no default and no optional variant.
 */
export interface RequestEnvelope<TPayload> {
  readonly id: string
  readonly method: string
  readonly payload: TPayload
  readonly timeoutMs: number
}

export type ResponseEnvelope<TResult> =
  | { readonly id: string, readonly ok: true, readonly result: TResult }
  | {
    readonly id: string
    readonly ok: false
    readonly code: OrivonErrorCode
    /** Absent when `code` is 'denied' -- see ./errors.js. */
    readonly platformCode?: string
    readonly message: string
  }

/**
 * Bytes flowing broker -> renderer on a socket's dedicated port.
 *
 * Always a copy. Never a transfer. See rule 1 above.
 */
export interface DataMessage {
  readonly kind: 'data'
  readonly handleId: string
  readonly chunk: Uint8Array
}

/**
 * The renderer acknowledging consumption, flowing renderer -> broker.
 *
 * The broker sends at most LIMITS.readWindowBytes ahead of what has been
 * acknowledged. When the outstanding credit budget reaches zero it STOPS
 * READING THE UNDERLYING OS SOCKET -- it does not keep reading and buffer in
 * the main process. That propagates real TCP backpressure to the remote peer,
 * which is the whole point: buffering in the broker just moves unbounded
 * memory growth from the renderer to the main process instead of solving it.
 */
export interface CreditMessage {
  readonly kind: 'credit'
  readonly handleId: string
  /** Bytes consumed since the last credit message. */
  readonly bytesConsumed: number
}

/** Broker -> renderer, once, when a stream reaches a terminal state. */
export interface StreamEndMessage {
  readonly kind: 'end'
  readonly handleId: string
  /** Absent on a clean end (EOF); present when the stream errored. */
  readonly code?: OrivonErrorCode
}

// THE WRITE DIRECTION (open-questions.md A37). The read direction above
// grants the RENDERER a byte-credit window; this is that mechanism run
// backwards -- the BROKER grants the renderer a byte window to post
// outbound bytes into, because a MessagePortMain has no pause()/drain of
// its own (electron.d.ts's MessagePortMain has exactly postMessage, start,
// close, on('message'), on('close')), so nothing at the transport layer
// stops a hostile renderer posting bytes faster than the OS socket drains
// (security-model.md T11b). See LIMITS.writeWindowBytes.
//
// NO SEQUENCE NUMBER: a MessagePort delivers in order without loss on this
// path (only the transfer-list path silently drops, per rule 1 above), a
// WritableStream's sink is never re-entered before the previous write
// settles, and write silence is TERMINAL (see WRITE_SILENCE_TIMEOUT_MS) --
// there is nothing to resynchronise after a timeout, so nothing for a
// sequence number to buy.

/**
 * An app writing bytes out, flowing renderer -> broker. One message per
 * `writable.write()` call -- WritableStream's own queuing guarantees the
 * broker never sees two of these for one handle out of order or
 * overlapping.
 */
export interface WriteMessage {
  readonly kind: 'write'
  readonly handleId: string
  readonly chunk: Uint8Array
}

/**
 * The broker accepting bytes, flowing broker -> renderer. `bytesAccepted`
 * is cumulative since the last ack on this handle -- CreditMessage's
 * `bytesConsumed`, run in the opposite direction -- and may be coalesced
 * the same way, via CREDIT_COALESCE_BYTES below.
 *
 * "Accepted" is deliberately not "written": a write resolves the instant
 * the OS socket's send buffer takes it under its own high-water mark,
 * before the bytes reach the peer -- exactly what handle-contracts.md's
 * SSTcpSocket backpressure section means by "the broker has accepted the
 * bytes into the OS socket send buffer".
 *
 * A `bytesAccepted: 0` message with nothing newly accepted is a valid
 * heartbeat -- see WRITE_HEARTBEAT_MS.
 */
export interface WriteAckMessage {
  readonly kind: 'write-ack'
  readonly handleId: string
  readonly bytesAccepted: number
}

/**
 * A write could not be accepted, flowing broker -> renderer. A separate
 * message rather than an optional field on WriteAckMessage, so a failure
 * can carry the real `platformCode` the way ResponseEnvelope's failure
 * branch does -- an ack's `bytesAccepted` has nowhere to put one.
 *
 * `code: 'denied'` never carries `platformCode` (./errors.js), though this
 * message has no policy check of its own that could produce a 'denied':
 * capability is checked once, at net.connect, not on every write.
 */
export interface WriteFailedMessage {
  readonly kind: 'write-failed'
  readonly handleId: string
  readonly code: OrivonErrorCode
  readonly platformCode?: string
}

/**
 * `writable.close()` -- half-close, FIN only, flowing renderer -> broker.
 * Travels on the port rather than CONTROL_CHANNEL so it stays ordered
 * against the writes it finishes, needing no new control method or
 * timeout. Half-close is load-bearing (handle-contracts.md SSTcpSocket's
 * close table): the readable side is left untouched.
 */
export interface WriteEndMessage {
  readonly kind: 'write-end'
  readonly handleId: string
}

/**
 * `writable.abort()` -- RST, discarding whatever this direction had
 * queued. Flowing renderer -> broker, on the port for the same ordering
 * reason as WriteEndMessage.
 */
export interface WriteAbortMessage {
  readonly kind: 'write-abort'
  readonly handleId: string
}

/** Every message the broker ever sends on a socket's dedicated port. */
export type BrokerToRendererMessage = DataMessage | StreamEndMessage | WriteAckMessage | WriteFailedMessage

/** Every message the renderer ever sends on a socket's dedicated port. */
export type RendererToBrokerMessage = CreditMessage | WriteMessage | WriteEndMessage | WriteAbortMessage

/**
 * Every message either side of a socket's dedicated port can send, in
 * either direction. Kept as the union of the two directional types above
 * -- rather than the other way round -- so a `PortLike.postMessage` typed
 * against the wrong direction is a type error instead of a silent
 * widening; that mistake is exactly what predated the write direction.
 */
export type PortMessage = BrokerToRendererMessage | RendererToBrokerMessage

/**
 * Credit updates are COALESCED: at most one message per this many bytes
 * consumed, or once per animation frame, whichever comes first.
 *
 * A 52 MB/s stream -- gate 4's measured throughput -- must not emit a broker
 * message per chunk. That would reintroduce exactly the per-message IPC cost
 * that moving bulk bytes off the main channel exists to avoid.
 *
 * Read-side coalescing (renderer -> broker CreditMessage) and write-side
 * coalescing (broker -> renderer WriteAckMessage) share this one threshold
 * -- one number every implementation agrees on (code-guidelines.md Rule 3).
 */
export const CREDIT_COALESCE_BYTES = 64 * 1024

/**
 * How often the broker emits a zero-byte WriteAckMessage while a write is
 * queued and not yet accepted by the OS socket. This is what lets
 * WRITE_SILENCE_TIMEOUT_MS below tell a genuinely slow peer (a choked
 * BitTorrent connection can legitimately stall for minutes) apart from a
 * dead transport (rule 2 above: this transport fails by silence, not by an
 * error) -- a flat deadline on every write cannot make that distinction
 * and would kill slow-but-healthy uploads.
 */
export const WRITE_HEARTBEAT_MS = 5_000

/**
 * How long the renderer waits with NO message at all arriving on a
 * socket's port -- not even a heartbeat -- before treating the write
 * direction as dead: both streams error, `closed` rejects with 'timeout',
 * and the handle is closed. Deliberately more than double
 * WRITE_HEARTBEAT_MS, so at least one heartbeat has a real chance to land
 * before this fires -- see ipc.test.ts for the assertion.
 */
export const WRITE_SILENCE_TIMEOUT_MS = 15_000
