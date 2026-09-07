// The renderer <-> main message shapes.
//
// Control operations (open, close, options) use normal Electron IPC; BULK
// BYTES use a dedicated MessageChannelMain port per handle, because
// per-message IPC is too slow for torrent-rate data
// (capability-api.md's "Throughput" section).
//
// SECURITY RULE, NOT AN OPTIMISATION DETAIL: the raw port NEVER crosses into
// the main world. The preload holds it in the isolated world and exposes only
// contextBridge closures over it. Transferring the port to the page -- the
// obvious move when optimising for throughput -- hands a raw socket to
// anything the page can reach (security-model.md T17). contextIsolation: true
// is what makes this free.
//
// TWO RULES FROM SPIKE GATE 0, both binding per handle-contracts.md's
// "What the shim must do" section:
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
 *
 * HARD LIMIT: `chunk.byteLength` MUST NOT exceed `LIMITS.writeWindowBytes`
 * (owner decision d-0021). A caller holding a larger buffer -- the shim
 * presenting a Node-shaped `write()`, or the renderer's own `writable` --
 * is responsible for splitting it into writeWindowBytes-sized or smaller
 * pieces and posting each as its own WriteMessage before the next one is
 * written. This is an obligation on the sender, not a suggestion: the
 * broker does not split, truncate, or buffer an oversized chunk on the
 * caller's behalf, and is entitled to treat one that exceeds the limit as
 * a protocol error.
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
 * handle-contracts.md's "TcpSocket" backpressure section means by "the broker has accepted the
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
 * timeout. Half-close is load-bearing (handle-contracts.md's "TcpSocket"
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

// THE DATAGRAM DIRECTION (udp.bind / udp.send). Deliberately NOT the byte
// messages above with a different name: a UDP socket is message-oriented, so
// one message here is exactly one packet, and the broker never splits or
// coalesces one (handle-contracts.md SSUdpSocket).
//
// THE ONE THING THAT MAKES THIS DIFFERENT FROM EVERY OTHER FLOW IN THIS FILE:
// exhausting the inbound window DISCARDS datagrams rather than slowing the
// sender down. UDP has no delivery guarantee and DHT/tracker traffic is built
// to tolerate loss, so buffering to avoid a drop would convert a loss-tolerant
// protocol into unbounded memory growth -- the exact failure the byte windows
// above exist to prevent. Loss is reported as a COUNT, never as an error.

/**
 * One inbound packet, flowing broker -> renderer.
 *
 * Always a copy. Never a transfer. See rule 1 above.
 *
 * `dropped` is the broker's RUNNING TOTAL of inbound datagrams discarded for
 * this handle, not a per-message delta -- so a renderer that missed a
 * DatagramDropMessage still converges on the right number, and
 * `UdpSocket.droppedInbound` never goes backwards.
 */
export interface DatagramMessage {
  readonly kind: 'datagram'
  readonly handleId: string
  readonly data: Uint8Array
  readonly address: string
  readonly port: number
  readonly family: 'IPv4' | 'IPv6'
  readonly dropped: number
}

/**
 * The running inbound-drop total on its own, flowing broker -> renderer.
 *
 * Exists because DatagramMessage cannot carry it in the one case that matters:
 * when the window is exhausted, EVERY datagram is being dropped, so no
 * DatagramMessage is being sent to piggyback the count on. Without this the
 * app's `droppedInbound` would freeze at its last delivered value during
 * exactly the overload it exists to report. Rate-limited to at most one per
 * DROP_REPORT_MS -- a drop storm must not become its own message storm.
 */
export interface DatagramDropMessage {
  readonly kind: 'datagram-dropped'
  readonly handleId: string
  readonly dropped: number
}

/**
 * The renderer acknowledging consumption, flowing renderer -> broker. The
 * inbound counterpart of CreditMessage above, and it carries BOTH units on
 * purpose.
 *
 * Two bounds, because either alone has a real failure mode. A count-only
 * window is what handle-contracts.md's "the readable internal queue is full"
 * describes, and it bounds message overhead -- but its worst case is
 * `inboundDatagramWindow` x `maxDatagramBytes` of pinned memory, which at any
 * count large enough for real DHT traffic is far more than a TCP socket may
 * pin. A byte-only window bounds that memory, but its worst case is a flood of
 * one-byte datagrams: a million messages inside one megabyte. Releasing both
 * is what makes neither reachable.
 */
export interface DatagramCreditMessage {
  readonly kind: 'datagram-credit'
  readonly handleId: string
  /** Datagrams consumed since the last credit message. */
  readonly datagramsConsumed: number
  /** Bytes those datagrams carried, summed. */
  readonly bytesConsumed: number
}

/**
 * An app sending one packet out, flowing renderer -> broker.
 *
 * `address` and `port` are the DESTINATION, and they are checked against the
 * origin's granted `udp.send` patterns FOR EVERY DATAGRAM -- unlike
 * `net.connect`, where capability is checked once at acquisition. A UDP socket
 * has no fixed peer, so there is no single acquisition-time destination to
 * check; the check moves to the send.
 *
 * `data.byteLength` MUST NOT exceed `LIMITS.maxDatagramBytes`. Same obligation
 * on the sender as WriteMessage's, and for the same reason: the broker does
 * not split, truncate or buffer an oversized one on the caller's behalf. A
 * datagram cannot be split anyway without ceasing to be the packet the app
 * asked to send.
 */
export interface SendMessage {
  readonly kind: 'send'
  readonly handleId: string
  readonly data: Uint8Array
  readonly address: string
  readonly port: number
}

/**
 * The broker accepting outbound packets, flowing broker -> renderer.
 * WriteAckMessage's counterpart, counted in datagrams rather than bytes.
 *
 * This exists for the same T11b reason the write window does: a
 * MessagePortMain has no flow control of its own, so nothing else stops a
 * renderer posting SendMessages faster than the broker can hand them to the
 * OS. A `datagramsAccepted: 0` message is a valid heartbeat.
 */
export interface SendAckMessage {
  readonly kind: 'send-ack'
  readonly handleId: string
  readonly datagramsAccepted: number
}

/**
 * One outbound datagram was not sent, flowing broker -> renderer.
 *
 * IT DOES NOT ERROR THE STREAM, and that is the whole point of it being a
 * counted report rather than a rejected write. A denied destination is
 * ORDINARY traffic for a P2P app: a DHT peer list routinely contains addresses
 * outside what the user granted, and erroring the socket on the first one
 * would kill a working swarm. Rejecting the sink's promise is the only way a
 * WritableStream can report a single failed write, and doing so errors the
 * stream permanently -- so this reports out of band instead, and the app reads
 * the total from `UdpSocket.droppedOutbound`.
 *
 * `code` is the closed-enum reason for THIS datagram; `dropped` is the running
 * total, same convention as DatagramMessage's. `code: 'denied'` never carries
 * `platformCode` (./errors.js) -- and 'denied' here stays as uniform as it is
 * everywhere else, so it can be counted but never used to map which
 * destinations a grant excludes.
 */
export interface SendFailedMessage {
  readonly kind: 'send-failed'
  readonly handleId: string
  readonly code: OrivonErrorCode
  readonly platformCode?: string
  readonly dropped: number
}

/** Every message the broker ever sends on a socket's dedicated port. */
export type BrokerToRendererMessage =
  | DataMessage | StreamEndMessage | WriteAckMessage | WriteFailedMessage
  | DatagramMessage | DatagramDropMessage | SendAckMessage | SendFailedMessage

/** Every message the renderer ever sends on a socket's dedicated port. */
export type RendererToBrokerMessage =
  | CreditMessage | WriteMessage | WriteEndMessage | WriteAbortMessage
  | DatagramCreditMessage | SendMessage

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
 * How long the renderer waits for a WriteAckMessage/WriteFailedMessage
 * covering an outstanding write before treating the WRITE DIRECTION as
 * dead: both streams error, `closed` rejects with 'timeout', and the
 * handle is closed.
 *
 * SCOPE, READ CAREFULLY: this timer runs ONLY WHILE AT LEAST ONE WRITE IS
 * OUTSTANDING -- posted via WriteMessage and not yet resolved by a
 * WriteAckMessage (a WRITE_HEARTBEAT_MS zero-byte ack counts as "still
 * alive" and keeps resetting this clock) or a WriteFailedMessage. It is NOT
 * a whole-port idle timeout: unrelated inbound traffic (DataMessage,
 * CreditMessage) and an ordinary silent gap with nothing outstanding -- a
 * choked BitTorrent peer's own keepalive interval is 120 seconds -- must
 * never arm or reset it.
 *
 * Correct arming: start (or restart) the clock when a WriteMessage is
 * posted with nothing already outstanding on that handle; keep it running
 * across each WRITE_HEARTBEAT_MS ack while the write is still unaccepted;
 * clear it the instant every outstanding write on that handle has been
 * resolved (accepted or failed). Deliberately more than double
 * WRITE_HEARTBEAT_MS, so at least one heartbeat has a real chance to land
 * before this fires -- see ipc.test.ts for the assertion.
 */
export const WRITE_SILENCE_TIMEOUT_MS = 15_000

/**
 * Datagram credit updates are COALESCED the same way byte credit is, but
 * counted in datagrams: at most one DatagramCreditMessage per this many
 * consumed.
 *
 * MUST STAY WELL BELOW `LIMITS.inboundDatagramWindow`. If it ever reached the
 * window, the renderer would not send its first credit until the window was
 * already exhausted, and the socket would fall into permanent drop -- every
 * datagram discarded, no credit ever released, no error anywhere. That failure
 * is silent and looks exactly like a quiet peer, which is why ./ipc.test.ts
 * asserts the relationship rather than leaving it to whoever edits the numbers.
 */
export const DATAGRAM_CREDIT_COALESCE = 32

/**
 * The floor on the interval between DatagramDropMessages for one handle.
 *
 * A drop storm is precisely when the app most wants the count and precisely
 * when it can least afford a message per event -- an unrated report would send
 * one message per DISCARDED datagram, which is more traffic than delivering
 * them would have been.
 *
 * There is deliberately no separate heartbeat or silence timeout for the
 * outbound direction. `WRITE_SILENCE_TIMEOUT_MS` covers an outstanding
 * SendMessage unchanged: unlike a TCP write, which can legitimately stall for
 * minutes against a choked peer, handing a datagram to the OS never blocks on
 * the network -- so silence on a send genuinely is a dead transport, and the
 * distinction WRITE_HEARTBEAT_MS exists to draw has nothing to draw.
 */
export const DROP_REPORT_MS = 1_000
