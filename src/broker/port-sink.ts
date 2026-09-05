import type { OrivonErrorCode } from '../contracts/errors.js'
import type { WriteAbortMessage, WriteAckMessage, WriteEndMessage, WriteFailedMessage, WriteMessage } from '../contracts/ipc.js'
import { CREDIT_COALESCE_BYTES, WRITE_HEARTBEAT_MS } from '../contracts/ipc.js'
import { errnoOf } from './errors.js'

// The WRITE half of the credit-window relay contracts/ipc.ts and
// handle-contracts.md's "Backpressure -- a credit window" specify: bytes
// flowing renderer -> broker over a socket's dedicated MessageChannelMain
// port, run BACKWARDS from ./port-pump.ts's read side -- here the BROKER
// grants the renderer a byte window to post into, because a
// MessagePortMain has no pause()/drain of its own (electron.d.ts's
// MessagePortMain has exactly postMessage, start, close, on('message'),
// on('close')), so nothing at the transport layer stops a hostile renderer
// posting faster than the OS socket drains (security-model.md T11b). Pure
// and Electron-free on purpose, the same way ./port-pump.ts is: `writable`
// is already a real WHATWG WritableStream by the time this file sees it,
// and `send` is injected.
//
// NO SEQUENCE NUMBER, NO PENDING-WRITE QUEUE. A WritableStreamDefaultWriter
// serialises its own sink calls -- write() is never re-entered before the
// previous call settles -- so tracking one scalar `unacked` count and one
// scalar `pendingCount` is sufficient; there is nothing to reorder. See
// contracts/ipc.ts's own header on why write-end/write-abort travel here
// rather than over CONTROL_CHANNEL.
//
// ACKS ARE FLUSHED EITHER ONCE CREDIT_COALESCE_BYTES HAS ACCEPTED, OR
// ONCE NOTHING ELSE IS OUTSTANDING (`pendingCount === 0`) -- so a lone slow
// write is never held hostage by coalescing, and a burst of same-tick
// writes naturally merges into one ack, the same way a burst of same-tick
// reads merges into one credit consumption on the other side.
//
// THE HEARTBEAT (WRITE_HEARTBEAT_MS) exists because contracts/ipc.ts's rule
// 2 -- every reply-carrying message needs a timeout, because this transport
// fails by silence -- cannot be a flat deadline here: a choked BitTorrent
// peer legitimately stalls a write for real, sometimes for minutes. A
// zero-byte WriteAckMessage lets the renderer's own silence timer
// distinguish "the peer is just slow" from "the transport died" without
// either side inventing a new message kind.
//
// NEVER AWAIT writer.close(). Measured directly against Duplex.toWeb (Node
// 24.11.1): its close() promise does not settle until the WHOLE DUPLEX is
// destroyed -- i.e. after the readable side also ends -- not when the FIN
// this call sends is itself flushed. Awaiting it here would deadlock any
// peer that (correctly, per half-close) keeps reading after our FIN and
// waits for our reply before sending its own.

export interface PortSinkOptions {
  readonly handleId: string
  readonly writable: WritableStream<Uint8Array>
  readonly send: (message: WriteAckMessage | WriteFailedMessage) => void
  /** LIMITS.writeWindowBytes in production; a caller-supplied number in tests. */
  readonly windowBytes: number
  /** Maps a raw write-rejection error to a closed-enum code. Defaults to 'internal'. */
  readonly mapError?: (error: unknown) => OrivonErrorCode
  /** WRITE_HEARTBEAT_MS in production; overridable in tests. */
  readonly heartbeatMs?: number
  /**
   * Called once if a write is refused (a window violation, a write after
   * write-end) or the underlying writable itself fails (a rejected write, an
   * app-initiated abort). Mirrors ./port-pump.ts's onStreamFailed: the caller
   * uses it to fail the handle for real, the same way a dead read direction
   * does, so the socket does not sit half-alive against its budget forever.
   */
  readonly onSinkFailed?: (code: OrivonErrorCode, error: unknown) => void
}

export interface PortSink {
  /** Ignored if addressed to a different handle, or if the sink is stopped/ended. */
  readonly handleWrite: (message: WriteMessage) => void
  /** `writable.close()` -- half-close, FIN only. Ignored if addressed to a different handle. */
  readonly handleEnd: (message: WriteEndMessage) => void
  /** `writable.abort()` -- RST. Ignored if addressed to a different handle. */
  readonly handleAbort: (message: WriteAbortMessage) => void
  /**
   * Broker-initiated teardown (revocation, session close). Aborts the
   * writer unless it has already ended cleanly via handleEnd. Idempotent.
   */
  readonly stop: (code?: OrivonErrorCode) => void
}

function toWriteFailed (handleId: string, code: OrivonErrorCode, error?: unknown): WriteFailedMessage {
  const platformCode = error === undefined ? undefined : errnoOf(error)
  return platformCode === undefined || code === 'denied'
    ? { kind: 'write-failed', handleId, code }
    : { kind: 'write-failed', handleId, code, platformCode }
}

export function createPortSink (options: PortSinkOptions): PortSink {
  const { handleId, writable, send, windowBytes, mapError = () => 'internal', heartbeatMs = WRITE_HEARTBEAT_MS, onSinkFailed } = options
  const writer = writable.getWriter()

  let unacked = 0
  let sinceLastAck = 0
  let pendingCount = 0
  let stopped = false
  let ending = false
  let ended = false
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined

  function clearHeartbeat (): void {
    if (heartbeatTimer !== undefined) { clearTimeout(heartbeatTimer); heartbeatTimer = undefined }
  }

  function armHeartbeat (): void {
    clearHeartbeat()
    if (pendingCount === 0) return
    heartbeatTimer = setTimeout(() => {
      if (stopped || pendingCount === 0) return
      send({ kind: 'write-ack', handleId, bytesAccepted: 0 })
      armHeartbeat()
    }, heartbeatMs)
  }

  function flush (): void {
    if (sinceLastAck > 0) {
      send({ kind: 'write-ack', handleId, bytesAccepted: sinceLastAck })
      sinceLastAck = 0
    }
  }

  function fail (code: OrivonErrorCode, error?: unknown): void {
    if (stopped) return
    stopped = true
    clearHeartbeat()
    send(toWriteFailed(handleId, code, error))
    // A synthesized reason when the caller has no raw error of its own (a
    // window violation is this sink's OWN policy decision, not something the
    // underlying writable threw) -- so onSinkFailed's second argument is
    // never undefined, matching ./port-pump.ts's onStreamFailed, which
    // always carries a real error alongside its mapped code.
    onSinkFailed?.(code, error ?? new Error(`write sink failed: ${code}`))
  }

  function closeWriterOnceDrained (): void {
    // The `ending` guard is load-bearing: pendingCount reaching zero is the
    // ORDINARY state between writes, not a signal that write-end was ever
    // requested. Without it, this fires -- and closes the writer -- after
    // every single write that happens to leave nothing else queued.
    if (!ending || pendingCount > 0 || ended) return
    ended = true
    clearHeartbeat()
    // Fire-and-forget on purpose -- see the file header. A rejection here
    // has nothing left to report to; the socket's own teardown path (which
    // already tolerates a duplicate call) is what notices a real failure.
    writer.close().catch(() => {})
  }

  return {
    handleWrite (message) {
      if (stopped || message.handleId !== handleId) return
      if (ending || ended) { send(toWriteFailed(handleId, 'closed')); return }

      const length = message.chunk.byteLength
      if (unacked + length > windowBytes) {
        fail('limit')
        return
      }

      unacked += length
      pendingCount++
      armHeartbeat()

      writer.write(message.chunk).then(
        () => {
          if (stopped) return
          unacked -= length
          sinceLastAck += length
          pendingCount--
          if (sinceLastAck >= CREDIT_COALESCE_BYTES || pendingCount === 0) flush()
          armHeartbeat()
          if (pendingCount === 0) closeWriterOnceDrained()
        },
        (error: unknown) => {
          if (stopped) return
          pendingCount--
          fail(mapError(error), error)
        }
      ).catch(() => {
        // The .then() handlers above never throw; this exists only so a
        // future edit that makes one of them async cannot turn its own
        // rejection into an unhandled one, matching ./ipc.ts's own rule for
        // exactly this shape of fire-and-forget chain.
      })
    },

    handleEnd (message) {
      if (stopped || ending || ended || message.handleId !== handleId) return
      ending = true
      closeWriterOnceDrained()
    },

    handleAbort (message) {
      if (stopped || message.handleId !== handleId) return
      const reason = new Error('write-abort')
      fail('reset', reason)
      writer.abort(reason).catch(() => {})
    },

    stop (code) {
      if (stopped || ended) return
      stopped = true
      clearHeartbeat()
      writer.abort(new Error(code ?? 'stopped')).catch(() => {})
    }
  }
}
