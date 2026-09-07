import type { OrivonErrorCode } from '../../contracts/errors.js'
import type {
  Datagram, DatagramCreditMessage, DatagramDropMessage, DatagramMessage, StreamEndMessage
} from '../../contracts/index.js'
import { DROP_REPORT_MS } from '../../contracts/index.js'

// The INBOUND half of the datagram relay -- ./port-pump.ts's counterpart for
// a message-oriented socket. Pure and Electron-free for the same reason:
// `readable` is already a real ReadableStream by the time this sees it and
// `send` is injected, so this runs under plain vitest with no MessagePortMain.
//
// THE ONE DIFFERENCE FROM ./port-pump.ts WORTH KNOWING BEFORE EDITING: running
// out of credit here does NOT stop data arriving. It stops this pump READING,
// which lets the adapter's own readable queue fill, and the adapter then
// DISCARDS (see ../adapters/README.md). There is no equivalent of the TCP
// pump's "stop reading the OS socket and the peer slows down" -- a UDP sender
// is not listening.

export interface DatagramPumpOptions {
  readonly handleId: string
  readonly readable: ReadableStream<Datagram>
  readonly send: (message: DatagramMessage | DatagramDropMessage | StreamEndMessage) => void
  /** LIMITS.inboundDatagramWindow in production; a caller-supplied number in tests. */
  readonly initialCredit: number
  /** LIMITS.inboundDatagramWindowBytes in production. */
  readonly initialCreditBytes: number
  /** Reads the adapter's live discard count -- see ../broker-contracts.ts's BoundUdpSocket. */
  readonly droppedInbound: () => number
  /** Maps a raw read error to a closed-enum code. Defaults to 'internal'. */
  readonly mapError?: (error: unknown) => OrivonErrorCode
  /** DROP_REPORT_MS in production; overridable in tests. */
  readonly dropReportMs?: number
  /** Called once if the stream ends ABNORMALLY -- see ./port-pump.ts's own onStreamFailed. */
  readonly onStreamFailed?: (code: OrivonErrorCode, error: unknown) => void
}

export interface DatagramPump {
  readonly handleCredit: (message: DatagramCreditMessage) => void
  readonly stop: (code?: OrivonErrorCode) => void
}

/** A credit figure the renderer chose, so it is checked rather than trusted. */
function usableCredit (value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

export function createDatagramPump (options: DatagramPumpOptions): DatagramPump {
  const { handleId, readable, send, droppedInbound, onStreamFailed, initialCredit, initialCreditBytes } = options
  const mapError = options.mapError ?? ((): OrivonErrorCode => 'internal')
  const dropReportMs = options.dropReportMs ?? DROP_REPORT_MS

  const reader = readable.getReader()
  let credit = initialCredit
  let creditBytes = initialCreditBytes
  let stopped = false
  let ended = false
  let waiting: (() => void) | undefined
  let dropTimer: ReturnType<typeof setInterval> | undefined
  let lastReportedDrops = droppedInbound()

  function endOnce (code?: OrivonErrorCode): void {
    if (ended) return
    ended = true
    send(code === undefined ? { kind: 'end', handleId } : { kind: 'end', handleId, code })
  }

  // Armed only while the pump is BLOCKED, which is the only situation where
  // the count could otherwise freeze: a delivered datagram carries `dropped`
  // itself, so while anything is flowing there is nothing this timer adds.
  function armDropReports (): void {
    if (dropTimer !== undefined) return
    dropTimer = setInterval(() => {
      const dropped = droppedInbound()
      if (dropped === lastReportedDrops) return
      lastReportedDrops = dropped
      send({ kind: 'datagram-dropped', handleId, dropped })
    }, dropReportMs)
    dropTimer.unref?.()
  }

  function disarmDropReports (): void {
    if (dropTimer === undefined) return
    clearInterval(dropTimer)
    dropTimer = undefined
  }

  async function waitForCredit (): Promise<void> {
    armDropReports()
    await new Promise<void>((resolve) => { waiting = resolve })
    waiting = undefined
    disarmDropReports()
  }

  async function pumpLoop (): Promise<void> {
    while (!stopped) {
      // Checked BEFORE the read, so the window overshoots by at most one
      // datagram: a datagram's size is not knowable until it has been read,
      // and refusing to read while any credit remains would stall the socket
      // whenever the next packet happened to be larger than the remainder.
      // Same property, and same reason, as a ReadableStream's high-water mark.
      if (credit <= 0 || creditBytes <= 0) {
        await waitForCredit()
        continue
      }
      const { done, value } = await reader.read()
      if (stopped) return
      if (done) {
        endOnce()
        return
      }
      credit -= 1
      creditBytes -= value.data.byteLength
      lastReportedDrops = droppedInbound()
      send({
        kind: 'datagram',
        handleId,
        data: value.data,
        address: value.address,
        port: value.port,
        family: value.family,
        dropped: lastReportedDrops
      })
    }
  }

  pumpLoop().catch((error: unknown) => {
    if (stopped) return
    const code = mapError(error)
    endOnce(code)
    onStreamFailed?.(code, error)
  })

  return {
    handleCredit (message) {
      if (stopped || message.handleId !== handleId) return
      // Clamped to each counter's own ceiling, mirroring ../port-pump.ts's
      // handleCredit: a self-reported delta must never push either counter
      // past the window it belongs to, or a renderer that over-reports
      // consumption could defeat the backpressure these windows exist to
      // enforce.
      credit = Math.min(credit + usableCredit(message.datagramsConsumed), initialCredit)
      creditBytes = Math.min(creditBytes + usableCredit(message.bytesConsumed), initialCreditBytes)
      waiting?.()
    },
    stop (code) {
      if (stopped) return
      stopped = true
      disarmDropReports()
      // Wake a blocked loop so it observes `stopped` and returns, rather than
      // sitting on a promise nothing will ever resolve.
      waiting?.()
      if (code !== undefined) endOnce(code)
      reader.cancel().catch(() => {
        // The stream is already errored or the socket is gone. Nothing further
        // to do on a teardown path, and a rejection here would be unhandled.
      })
    }
  }
}
