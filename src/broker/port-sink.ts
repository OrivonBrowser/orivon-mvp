import type { OrivonErrorCode } from '../contracts/errors.js'
import type { WriteAbortMessage, WriteAckMessage, WriteEndMessage, WriteFailedMessage, WriteMessage } from '../contracts/ipc.js'
import { CREDIT_COALESCE_BYTES, WRITE_HEARTBEAT_MS } from '../contracts/ipc.js'
import { errnoOf } from './errors.js'

// The WRITE half of the credit-window relay (contracts/ipc.ts,
// handle-contracts.md's "Backpressure -- a credit window"), run BACKWARDS
// from ./port-pump.ts's read side: the BROKER grants the byte window here.
// Pure and Electron-free like ./port-pump.ts -- `writable` is already a
// real WHATWG WritableStream, `send` is injected. See
// src/broker/README.md's "Design notes" for why there is no sequence
// number, why the heartbeat exists, and the Duplex.toWeb close()
// measurement the trap below is written around.

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
   * Broker-initiated teardown (revocation, session close, or any other
   * reason `socket.closed` settled). Stops accepting further inbound
   * writes. Does NOT touch the writer -- the real wire teardown already
   * happened via the injected destroy callback before a caller reaches
   * this; see the implementation's own comment. Idempotent.
   *
   * `code`, given only for an ABNORMAL teardown, reports the real reason
   * to the renderer for any write still outstanding, rather than leaving
   * it to time out.
   */
  readonly stop: (code?: OrivonErrorCode) => void
}

/**
 * A hard ceiling on outstanding (accepted, not yet settled) writes,
 * independent of `windowBytes`. A zero- or near-zero-length chunk barely
 * touches the byte-based window at all -- `unacked` never grows for a
 * zero-length one -- so without this a flood of them could queue an
 * unbounded number of live promises, Node stream queue entries and
 * heartbeat-timer resets, reaching the T11b DoS the window exists to shut
 * through the one dimension it does not bound (message count, not bytes).
 */
const MAX_PENDING_WRITES = 128

function toWriteFailed (handleId: string, code: OrivonErrorCode, error?: unknown): WriteFailedMessage {
  const platformCode = error === undefined ? undefined : errnoOf(error)
  return platformCode === undefined || code === 'denied'
    ? { kind: 'write-failed', handleId, code }
    : { kind: 'write-failed', handleId, code, platformCode }
}

/**
 * True for the write() rejection Node produces when OUR OWN writable
 * already ended on its own -- confirmed empirically (Node 24.11.1) as the
 * shape a peer FIN leaves behind under `allowHalfOpen: false`
 * (docs/open-questions.md A69): an AbortError carrying no real transport
 * errno. Distinct from a genuine transport failure (ECONNRESET, EPIPE, ...),
 * which always carries one.
 */
function isWritableAlreadyEnded (error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    (error as { name?: unknown }).name === 'AbortError' &&
    (error as { code?: unknown }).code === 'ABORT_ERR'
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
      // Flush whatever was earned since the last ack first: a heartbeat that
      // always claimed zero would tell the renderer nothing was accepted
      // even when something genuinely was, just not yet enough to cross
      // CREDIT_COALESCE_BYTES on its own.
      if (sinceLastAck > 0) flush()
      else send({ kind: 'write-ack', handleId, bytesAccepted: 0 })
      armHeartbeat()
    }, heartbeatMs)
    // Self-re-arming and otherwise unbounded: an orphaned socket nobody
    // ever stops (B-F8) would keep this timer -- and with it the whole
    // process -- alive on its own without this.
    heartbeatTimer.unref()
  }

  // `force` matters for a zero-length write: it adds nothing to
  // `sinceLastAck`, so once it is the last thing outstanding the ordinary
  // sinceLastAck > 0 guard would never flush it, and its write() promise
  // would resolve with no ack ever following.
  function flush (force = false): void {
    if (sinceLastAck > 0 || force) {
      send({ kind: 'write-ack', handleId, bytesAccepted: sinceLastAck })
      sinceLastAck = 0
    }
  }

  // `notifyHandle: false` is for A69's peer-FIN case only (see the write
  // rejection handler below): that failure is this direction's own, not the
  // whole handle's, so onSinkFailed -- which the caller uses to fail the
  // WHOLE socket, read side included -- must not run.
  function fail (code: OrivonErrorCode, error?: unknown, notifyHandle = true): void {
    if (stopped) return
    stopped = true
    clearHeartbeat()
    send(toWriteFailed(handleId, code, error))
    if (!notifyHandle) return
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
    // NEVER AWAIT THIS. Duplex.toWeb's close() (Node 24.11.1) does not
    // settle until the whole duplex is destroyed -- after the readable side
    // also ends -- not when this call's own FIN is flushed. Awaiting it
    // would deadlock a peer that (correctly, per half-close) keeps reading
    // after our FIN and waits for a reply before sending its own. A
    // rejection here still needs reporting -- the FIN may never have gone
    // out, and the app should not believe its half-close succeeded.
    writer.close().catch((error: unknown) => { send(toWriteFailed(handleId, mapError(error), error)) })
  }

  return {
    handleWrite (message) {
      if (stopped || message.handleId !== handleId) return
      // Deliberately rejects only THIS write, not the whole sink: a
      // well-behaved renderer's own WritableStreamDefaultWriter already
      // refuses to call write() after close(), so this only fires for a
      // hostile message sent directly on the port. Failing the write
      // direction is enough -- the socket stays registered and the READ
      // side stays alive, which is correct half-close (the write side
      // already has its real FIN queued via closeWriterOnceDrained), not
      // an oversight.
      if (ending || ended) { send(toWriteFailed(handleId, 'closed')); return }

      const length = message.chunk.byteLength
      if (unacked + length > windowBytes || pendingCount >= MAX_PENDING_WRITES) {
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
          if (sinceLastAck >= CREDIT_COALESCE_BYTES || pendingCount === 0) flush(pendingCount === 0)
          armHeartbeat()
          if (pendingCount === 0) closeWriterOnceDrained()
        },
        (error: unknown) => {
          if (stopped) return
          pendingCount--
          // A69: the writable ended on its own, not the transport -- fail
          // only this direction, with the code for "you wrote after your
          // own writable already ended", never the whole handle.
          if (isWritableAlreadyEnded(error)) { fail('closed', undefined, false); return }
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
      if (stopped) return
      // `code` is only ever given for an ABNORMAL teardown (socket-relay.ts
      // passes one when socket.closed rejects; an ordinary close/
      // sessionEnded passes none, matching ./port-pump.ts's own stop(code)
      // convention). A write still outstanding when that happens WOULD
      // eventually settle on its own once the real teardown below reaches
      // the underlying stream -- but `stopped` becomes true first, so that
      // settlement is silently swallowed, and the renderer would otherwise
      // learn nothing until its own WRITE_SILENCE_TIMEOUT_MS, reporting a
      // generic 'timeout' rather than the real reason.
      if (code !== undefined && pendingCount > 0) send(toWriteFailed(handleId, code))
      stopped = true
      clearHeartbeat()
      // Deliberately does NOT touch `writer`. By the time a caller reaches
      // this (socket-relay.ts, from socket.closed settling), the REAL wire
      // teardown has already happened -- HandleTable's injected destroy
      // callback (node-adapters.ts's destroySocket) already sent the
      // CloseReason-correct signal (FIN for 'closed'/'sessionEnded', RST
      // for 'revoked') directly on the raw socket, and handle-contracts.ts
      // documents that release() waits for it before `closed` ever settles.
      // Calling writer.abort() here would send a SECOND, possibly
      // contradictory signal -- an RST after a real FIN already went out
      // for an ordinary 'closed'. Any write still in flight settles on its
      // own once the underlying stream reflects that same real teardown.
    }
  }
}
