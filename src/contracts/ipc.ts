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

export type PortMessage = DataMessage | CreditMessage | StreamEndMessage

/**
 * Credit updates are COALESCED: at most one message per this many bytes
 * consumed, or once per animation frame, whichever comes first.
 *
 * A 52 MB/s stream -- gate 4's measured throughput -- must not emit a broker
 * message per chunk. That would reintroduce exactly the per-message IPC cost
 * that moving bulk bytes off the main channel exists to avoid.
 */
export const CREDIT_COALESCE_BYTES = 64 * 1024
