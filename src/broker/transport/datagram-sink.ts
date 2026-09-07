import type { OrivonErrorCode } from '../../contracts/errors.js'
import type { Datagram, SendAckMessage, SendFailedMessage, SendMessage } from '../../contracts/index.js'
import type { SendOutcome } from '../broker-contracts.js'

// The OUTBOUND half of the datagram relay -- ./port-sink.ts's counterpart, and
// the place A87's decision actually lives.
//
// THE ONE RULE THAT MAKES THIS FILE DIFFERENT FROM ./port-sink.ts: a REFUSED
// datagram is not a failure of the socket. A destination outside the granted
// `udp.send` patterns is ordinary traffic for a P2P app -- a DHT peer list
// routinely names private addresses -- so a refusal is counted and reported,
// and the socket stays usable. Only a renderer IGNORING ITS WINDOW fails the
// handle, because that is not traffic, it is a broken or hostile renderer.

export interface DatagramSinkOptions {
  readonly handleId: string
  readonly send: (message: SendAckMessage | SendFailedMessage) => void
  /** The broker's already-authorising send -- see ../index.ts's `authorisedSend`. */
  readonly sendDatagram: (datagram: Datagram) => Promise<SendOutcome>
  /** LIMITS.outboundDatagramWindow in production; a caller-supplied number in tests. */
  readonly windowDatagrams: number
  /** Called once if the renderer exceeds its window. NOT called for a refused datagram. */
  readonly onSinkFailed?: (code: OrivonErrorCode, error: unknown) => void
}

export interface DatagramSink {
  readonly handleSend: (message: SendMessage) => void
  readonly stop: () => void
}

export function createDatagramSink (options: DatagramSinkOptions): DatagramSink {
  const { handleId, send, sendDatagram, windowDatagrams, onSinkFailed } = options

  let stopped = false
  let inFlight = 0
  let dropped = 0
  let pendingAcks = 0
  let ackScheduled = false

  // Coalesced on a microtask rather than sent per datagram. A burst of sends
  // that all complete in one turn -- the common case, since handing a datagram
  // to the OS does not wait on the network -- becomes one ack instead of one
  // per packet, which is the same per-message cost CREDIT_COALESCE_BYTES
  // exists to avoid on the byte path.
  function scheduleAck (): void {
    if (ackScheduled) return
    ackScheduled = true
    queueMicrotask(() => {
      ackScheduled = false
      if (stopped || pendingAcks === 0) return
      const datagramsAccepted = pendingAcks
      pendingAcks = 0
      send({ kind: 'send-ack', handleId, datagramsAccepted })
    })
  }

  function reportRefusal (outcome: Extract<SendOutcome, { sent: false }>): void {
    dropped += 1
    const message: SendFailedMessage = outcome.platformCode === undefined
      ? { kind: 'send-failed', handleId, code: outcome.code, dropped }
      : { kind: 'send-failed', handleId, code: outcome.code, platformCode: outcome.platformCode, dropped }
    send(message)
  }

  return {
    handleSend (message) {
      if (stopped) return
      if (inFlight >= windowDatagrams) {
        // Terminal, matching ../port-sink.ts's own window-violation branch:
        // without this, every further handleSend() call re-enters this same
        // branch and re-fires onSinkFailed (which calls socket.fail()) once
        // per message for as long as a broken or hostile renderer keeps
        // sending, instead of failing the handle exactly once.
        stopped = true
        onSinkFailed?.('limit', new Error(`more than ${String(windowDatagrams)} datagrams in flight`))
        return
      }
      inFlight += 1
      // `family` is not carried on the wire: the destination decides it, and
      // the adapter reads it off the address it is given. Filled in here so
      // the Datagram type is honestly satisfied rather than cast away.
      const datagram: Datagram = {
        data: message.data,
        address: message.address,
        port: message.port,
        family: message.address.includes(':') ? 'IPv6' : 'IPv4'
      }
      sendDatagram(datagram).then(
        (outcome) => {
          inFlight -= 1
          if (stopped) return
          if (outcome.sent) {
            pendingAcks += 1
            scheduleAck()
          } else {
            reportRefusal(outcome)
          }
        },
        (error: unknown) => {
          // `sendDatagram` promises it never rejects (../broker-contracts.ts's
          // SendOutcome). Guarded anyway: this chain is nobody's awaited
          // promise, so a rejection escaping here is an unhandled rejection,
          // which on the Electron main process takes the whole browser down.
          inFlight -= 1
          if (stopped) return
          reportRefusal({ sent: false, code: 'internal' })
          console.error('[broker] a udp send rejected, which it must not', error)
        }
      )
    },
    stop () {
      stopped = true
    }
  }
}
