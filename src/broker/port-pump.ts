import type { OrivonErrorCode } from '../contracts/errors.js'
import type { CreditMessage, DataMessage, StreamEndMessage } from '../contracts/ipc.js'

// The READ half of the credit-window relay contracts/ipc.ts and
// handle-contracts.md's "Backpressure -- a credit window" specify: bytes
// flowing broker -> renderer over a socket's dedicated MessageChannelMain
// port. Pure and Electron-free on purpose, the same way ./policy/ is --
// `readable` is already a real WHATWG ReadableStream by the time this file
// sees it (Duplex.toWeb, ./ipc.ts's dialOne), and `send` is injected, so
// this whole module runs under plain Node/vitest with no MessagePortMain at
// all. ./ipc.ts is where a real port's `postMessage`/`on('message')` get
// wired to `send`/`handleCredit`.
//
// THE WRITE HALF (an app writing bytes out) IS DELIBERATELY NOT HERE. There
// is no wire message for it anywhere in contracts/ipc.ts -- handle-
// contracts.md's Backpressure section only specifies the read side in
// detail, and capability-api.md's Throughput section and ADR-0008 both stop
// at the same point. Inventing one here would be a contracts decision made
// from inside a broker-owned PR, which the write half's own review flagged
// and filed as an open question rather than deciding silently.
//
// WHAT "STOPS READING THE UNDERLYING OS SOCKET" ACTUALLY MEANS HERE: this
// pump never calls reader.read() again once `credit` reaches zero or below.
// It does not keep draining `readable` into a local buffer while waiting for
// credit -- that would just move the unbounded-memory problem T11b names
// from the renderer to here, which is exactly what the credit window exists
// to prevent (handle-contracts.md's own words for it).
//
// CREDIT IS BOUNDED BY THE WINDOW, NOT TRUSTED AS REPORTED. `handleCredit`
// clamps the running budget to `initialCredit`, because that is what
// contracts/ipc.ts actually specifies: "the broker sends at most
// LIMITS.readWindowBytes ahead of what has been acknowledged". Credit is a
// remaining-budget counter, so `sent - acknowledged <= window` is the same
// statement as `credit <= initialCredit`.
//
// This file previously trusted the reported figure, on the reasoning that an
// over-reporting renderer only inflates its own queue in its own process.
// That reasoning was wrong in one direction: a CreditMessage carrying
// Infinity made `credit > 0` permanently true, so the pump never stopped
// reading the OS socket -- defeating A2 above outright, and with it the TCP
// backpressure to the remote peer that is the whole point. Whatever the
// renderer's own queue does, the broker must not be talked out of the window
// by the party the window exists to bound.
//
// Non-finite and negative figures are rejected rather than applied: NaN
// poisoned the counter permanently (every later comparison false), and a
// negative value drove it below zero with no way back.

export interface PortPumpOptions {
  readonly handleId: string
  readonly readable: ReadableStream<Uint8Array>
  readonly send: (message: DataMessage | StreamEndMessage) => void
  /** The read-ahead budget in bytes -- LIMITS.readWindowBytes in production; a caller-supplied number in tests. */
  readonly initialCredit: number
  /** Maps a raw read-stream error to a closed-enum code. Defaults to 'internal' -- a caller with real errno detail (./ipc.ts) supplies a sharper one. */
  readonly mapError?: (error: unknown) => OrivonErrorCode
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
  const { handleId, readable, send, initialCredit, mapError = () => 'internal' } = options
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
      if (!stopped) sendEnd(mapError(error))
    } finally {
      running = false
    }
  }

  void pumpLoop()

  return {
    handleCredit (message) {
      if (stopped || message.handleId !== handleId) return
      const { bytesConsumed } = message
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
