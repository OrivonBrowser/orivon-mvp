import type { OrivonErrorCode } from '../contracts/errors.js'
import type { CreditMessage, DataMessage, StreamEndMessage } from '../contracts/ipc.js'

// The READ half of the credit-window relay contracts/ipc.ts and
// handle-contracts.md's "Backpressure" specify. Pure and Electron-free, like
// ./policy/ -- `readable` is already a real WHATWG ReadableStream by the time
// this file sees it (Duplex.toWeb, ./ipc.ts's dialOne), and `send` is
// injected, so this module runs under plain Node/vitest with no
// MessagePortMain at all. See README.md, Design notes, for the write-half
// boundary and the credit-trust history.

export interface PortPumpOptions {
  readonly handleId: string
  readonly readable: ReadableStream<Uint8Array>
  readonly send: (message: DataMessage | StreamEndMessage) => void
  /** The read-ahead budget in bytes -- LIMITS.readWindowBytes in production; a caller-supplied number in tests. */
  readonly initialCredit: number
  /** Maps a raw read-stream error to a closed-enum code. Defaults to 'internal' -- a caller with real errno detail (./ipc.ts) supplies a sharper one. */
  readonly mapError?: (error: unknown) => OrivonErrorCode
  /**
   * Called once if the stream ends ABNORMALLY -- a peer reset, not a clean
   * EOF and not stop(). The socket died underneath us, and nothing else in
   * the pipeline notices: handle-contracts.md's own words are that without an
   * entry point for this "a peer RST is reported as a clean successful
   * close, which is the COMMON way a socket ends". ./ipc.ts uses it to fail
   * the handle for real (FailableTcpSocket.fail), which both releases it --
   * otherwise it stays counted against the origin's socket budget for the
   * life of the process -- and rejects `closed` with the real reason,
   * instead of the app seeing a clean successful close for a connection that
   * was actually reset.
   *
   * The raw error is passed alongside the mapped code so a caller with
   * platformCode-extraction logic of its own (ipc.ts already has one, for
   * this exact error) does not need a second copy of it.
   *
   * NOT called on clean EOF: a peer FIN ends `readable` but leaves the
   * socket writable, and closing it there would break half-close
   * (contracts/handles.ts's close table).
   */
  readonly onStreamFailed?: (code: OrivonErrorCode, error: unknown) => void
}

export interface PortPump {
  /**
   * Applies a renderer-reported CreditMessage. Ignored if addressed to a
   * different handle, received after stop(), or carrying a non-finite or
   * negative figure; the resulting budget never exceeds `initialCredit`.
   */
  readonly handleCredit: (message: CreditMessage) => void
  /** Ends the pump immediately: sends a terminal StreamEndMessage (once, ever) and releases the reader. Idempotent. */
  readonly stop: (code?: OrivonErrorCode) => void
}

export function createPortPump (options: PortPumpOptions): PortPump {
  const { handleId, readable, send, initialCredit, mapError = () => 'internal', onStreamFailed } = options
  const reader = readable.getReader()
  let credit = initialCredit
  let running = false
  let stopped = false
  let endSent = false

  function sendEnd (code?: OrivonErrorCode): void {
    if (endSent) return
    endSent = true
    send(code === undefined ? { kind: 'end', handleId } : { kind: 'end', handleId, code })
  }

  // Re-entrant on purpose: both the initial call below and every resuming
  // handleCredit() call this same function. `running` guards against two
  // concurrent reader.read() calls on the one reader a stream permits.
  async function pumpLoop (): Promise<void> {
    if (running || stopped) return
    running = true
    try {
      // Never drains ahead of credit: this loop simply stops calling
      // reader.read() once credit reaches zero, rather than buffering
      // `readable` locally while waiting -- so the OS socket itself
      // backpressures (draining ahead would move T11b's unbounded-memory
      // problem from the renderer to here instead of preventing it).
      while (!stopped && credit > 0) {
        const { value, done } = await reader.read()
        if (stopped) break
        if (done) {
          sendEnd()
          break
        }
        send({ kind: 'data', handleId, chunk: value })
        credit -= value.byteLength
      }
    } catch (error) {
      if (!stopped) {
        // A terminal state, same as stop(): an errored ReadableStream
        // rejects every FUTURE read() with this same error without
        // re-invoking its underlying source (WHATWG Streams spec), so a
        // stray handleCredit() arriving after this point would otherwise
        // re-enter this catch block with the identical error and call
        // onStreamFailed a second time -- and a second FailableTcpSocket.fail
        // on an already-failed handle is a duplicate teardown call, which
        // ./ipc.ts's cleanup() is separately written to tolerate.
        stopped = true
        const code = mapError(error)
        sendEnd(code)
        onStreamFailed?.(code, error)
      }
    } finally {
      running = false
    }
  }

  void pumpLoop()

  return {
    handleCredit (message) {
      if (stopped || message.handleId !== handleId) return
      const { bytesConsumed } = message
      // Non-finite or negative figures are ignored outright, and the total is
      // clamped to initialCredit: a self-reported delta must never push
      // credit past the window or stop it reaching zero -- either would
      // defeat the backpressure this pump exists to enforce (README.md,
      // Design notes).
      if (!Number.isFinite(bytesConsumed) || bytesConsumed < 0) return
      credit = Math.min(credit + bytesConsumed, initialCredit)
      void pumpLoop()
    },
    stop (code) {
      if (stopped) return
      stopped = true
      sendEnd(code)
      // Fire-and-forget, matching HandleTable.revoke()'s own "does not wait
      // for teardown" rule -- the caller is told the pump has ended (via the
      // end message above) before this settles, and a rejected cancel() here
      // has nothing left to report to.
      reader.cancel().catch(() => {})
    }
  }
}
