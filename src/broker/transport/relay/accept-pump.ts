import type { OrivonErrorCode } from '../../../contracts/errors.js'
import type { CreditMessage, StreamEndMessage } from '../../../contracts/ipc.js'
import type { FailableTcpSocket } from '../../handles/handle-contracts.js'
import { isOrivonErrorLike } from '../../errors.js'

// The ACCEPT-DEMAND half of TcpServer.connections' own pull-driven design
// (handle-contracts.md's "TcpServer" section: highWaterMark 0, one accept per
// app read). ./port-pump.ts's counterpart for a non-byte stream -- same idea,
// "never read ahead of demand, and tell the renderer once when the stream
// ends" -- applied where one unit of demand is ONE connection, not N bytes
// (code-guidelines.md Rule 3: the reason is shared, the shape genuinely
// differs, which is why this is its own file rather than a generic parameter
// on port-pump.ts).
//
// REUSES CreditMessage (contracts/ipc.ts) AS THE DEMAND SIGNAL, RATHER THAN A
// NEW WIRE MESSAGE -- a flagged AI judgment call, not an owner decision
// (open-questions.md A185). `src/contracts/` is settled for this lane (A167's
// own scope rule: no `RendererToBrokerMessage` member exists for "accept the
// next connection", and adding one was out of bounds here). CreditMessage's
// wire shape -- `{kind:'credit', handleId, bytesConsumed}` -- is already the
// one RendererToBrokerMessage member that means "the renderer is ready for
// more"; `bytesConsumed` is reinterpreted here as a COUNT of connections the
// app's own `connections.getReader().read()` calls have asked for, always 1
// per call (../../../preload/ports/server.ts's own `reportAccepted`). See A185
// for the alternative this stopped short of (a purpose-built message member)
// and why.

export interface AcceptPumpOptions {
  readonly handleId: string
  readonly connections: ReadableStream<FailableTcpSocket>
  /** Called once per accepted connection, in order, with one unit of demand already spent. */
  readonly onAccepted: (socket: FailableTcpSocket) => void
  /** Sends the terminal StreamEndMessage -- injected the same way port-pump.ts's own `send` is. */
  readonly send: (message: StreamEndMessage) => void
  /**
   * The demand ceiling -- LIMITS.concurrentSockets in production
   * (./server.ts), matching port-pump.ts's own `initialCredit` clamp:
   * a compromised renderer claiming an implausible `bytesConsumed` must not
   * be able to accumulate unbounded demand ahead of genuine page reads.
   */
  readonly maxOutstandingDemand: number
  /**
   * Called once if `connections` ends ABNORMALLY -- the listener died
   * underneath us, mirroring port-pump.ts's own `onStreamFailed`: without
   * this, nothing tells the SERVER's own handle to release, and it stays
   * counted against the origin's socket budget for the life of the process.
   */
  readonly onStreamFailed?: (code: OrivonErrorCode, error: unknown) => void
}

export interface AcceptPump {
  /** Applies a renderer-reported demand unit. Ignored if addressed to a different handle, received after stop(), or non-positive. */
  readonly handleDemand: (message: CreditMessage) => void
  /** Ends the pump immediately: sends a terminal StreamEndMessage (once, ever) and releases the reader. Idempotent. */
  readonly stop: (code?: OrivonErrorCode) => void
}

export function createAcceptPump (options: AcceptPumpOptions): AcceptPump {
  const { handleId, connections, onAccepted, send, maxOutstandingDemand, onStreamFailed } = options
  const reader = connections.getReader()
  let demand = 0
  let running = false
  let stopped = false
  let endSent = false

  function sendEnd (code?: OrivonErrorCode): void {
    if (endSent) return
    endSent = true
    send(code === undefined ? { kind: 'end', handleId } : { kind: 'end', handleId, code })
  }

  // Re-entrant on purpose, matching port-pump.ts's own pumpLoop: both the
  // initial demand and every resuming handleDemand() call this: `running`
  // guards against two concurrent reader.read() calls on the one reader a
  // stream permits.
  async function pumpLoop (): Promise<void> {
    if (running || stopped) return
    running = true
    try {
      // Never accepts ahead of demand -- exactly the property this file
      // exists to hold. A read only happens because a unit of demand was
      // already spent below, one accept per unit, matching the broker's own
      // `entry.connections`' highWaterMark: 0 contract one layer up
      // (capabilities/net.ts).
      while (!stopped && demand > 0) {
        const { value, done } = await reader.read()
        if (stopped) break
        if (done) { sendEnd(); break }
        demand -= 1
        onAccepted(value)
      }
    } catch (error) {
      if (!stopped) {
        // capabilities/net.ts's own `pull()` already maps a raw accept()
        // failure to an OrivonError via mapIoError before erroring this
        // controller -- nothing here needs a second mapping
        // (code-guidelines.md Rule 3), unlike port-pump.ts's own mapError,
        // which sees a RAW stream error straight off Duplex.toWeb.
        stopped = true
        const code = isOrivonErrorLike(error) ? error.code : 'internal'
        sendEnd(code)
        onStreamFailed?.(code, error)
      }
    } finally {
      running = false
    }
  }

  return {
    handleDemand (message) {
      if (stopped || message.handleId !== handleId) return
      const units = message.bytesConsumed
      if (!Number.isFinite(units) || units <= 0) return
      demand = Math.min(demand + units, maxOutstandingDemand)
      void pumpLoop()
    },
    stop (code) {
      if (stopped) return
      stopped = true
      sendEnd(code)
      // Fire-and-forget, matching port-pump.ts's own stop(): the caller is
      // told the pump has ended (via the end message above) before this
      // settles, and a rejected cancel() here has nothing left to report to.
      reader.cancel().catch(() => {})
    }
  }
}
