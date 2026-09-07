import type { OrivonError, OrivonErrorCode } from '../contracts/errors.js'
import type { SendRefusal } from '../contracts/handles.js'
import type { BrokerToRendererMessage } from '../contracts/ipc.js'
import { DATAGRAM_CREDIT_COALESCE, WRITE_SILENCE_TIMEOUT_MS } from '../contracts/ipc.js'
import { LIMITS } from '../contracts/limits.js'
import type { PortLike } from './socket-port.js'
import { toOrivonError } from './orivon-error.js'

// The isolated-world state machine for ONE UDP socket's dedicated port --
// ./socket-port.ts's counterpart, and the preload-side end of
// ../broker/transport/datagram-pump.ts and datagram-sink.ts.
//
// TWO THINGS ARE COUNTED HERE RATHER THAN THROWN, and both are A87:
// a refused outbound datagram resolves its send and bumps droppedOutbound,
// and inbound loss arrives as a running total. Neither may reject, because
// the only way ../preload's main world could surface a rejection is by
// erroring the app's stream, which kills the socket.

/** The datagram shape crossing the bridge. `family` is informational on the way out. */
export interface WireDatagram {
  readonly data: Uint8Array
  readonly address: string
  readonly port: number
  readonly family: 'IPv4' | 'IPv6'
}

export interface DatagramPortOptions {
  readonly handleId: string
  readonly port: PortLike
  /** LIMITS.outboundDatagramWindow in production; a caller-supplied number in tests. */
  readonly windowDatagrams?: number
  /** WRITE_SILENCE_TIMEOUT_MS in production; overridable in tests. */
  readonly silenceTimeoutMs?: number
}

export interface DatagramPort {
  onDatagram: (cb: (datagram: WireDatagram) => void) => void
  /** Fires once when the read side reaches a terminal state. */
  onReadEnd: (cb: (code: OrivonErrorCode | undefined) => void) => void
  /** Fires once per refused outbound datagram (A87), alongside `onDropped`'s running count. */
  onRefusal: (cb: (refusal: SendRefusal) => void) => void
  /** The consumer reports what it drained; coalesced into DatagramCreditMessages. */
  reportConsumed: (datagrams: number, bytes: number) => void
  /**
   * Queues one datagram. Resolves once it has been POSTED and the outbound
   * window has room -- not once it reached the peer, which UDP never tells
   * anyone. NEVER REJECTS for a refusal: a datagram the broker declined
   * resolves like any other and shows up in `droppedOutbound` instead.
   */
  send: (datagram: WireDatagram) => Promise<void>
  /** Fires whenever either loss counter moves. Push-based so the main world never has to call back synchronously. */
  onDropped: (cb: (inbound: number, outbound: number) => void) => void
  /** Fires once if the port goes silent with sends outstanding. */
  onFatal: (cb: (code: OrivonErrorCode) => void) => void
  readonly closed: Promise<void>
  /** Local cleanup only -- stops the timer and the message listener. Sends nothing. */
  dispose: () => void
}

export function createDatagramPort (options: DatagramPortOptions): DatagramPort {
  const { handleId, port } = options
  const windowDatagrams = options.windowDatagrams ?? LIMITS.outboundDatagramWindow
  const silenceTimeoutMs = options.silenceTimeoutMs ?? WRITE_SILENCE_TIMEOUT_MS

  let datagramCb: ((datagram: WireDatagram) => void) | undefined
  let readEndCb: ((code: OrivonErrorCode | undefined) => void) | undefined
  let droppedCb: ((inbound: number, outbound: number) => void) | undefined
  let refusalCb: ((refusal: SendRefusal) => void) | undefined
  let fatalCb: ((code: OrivonErrorCode) => void) | undefined

  let disposed = false
  let droppedInbound = 0
  let droppedOutbound = 0

  let consumedDatagrams = 0
  let consumedBytes = 0
  let creditFlushScheduled = false

  let outstanding = 0
  const waiting: Array<() => void> = []
  let silenceTimer: ReturnType<typeof setTimeout> | undefined
  // Separate from `disposed`: dispose() is local-only cleanup, but a queued
  // send must also stop resuming once the port ends remotely or goes silent
  // -- releaseAll() below wakes every waiting send() at once, and each one's
  // post-await check needs to see every one of those three reasons, not just
  // a local dispose().
  let terminated = false

  let closedSettled = false
  let resolveClosed: () => void = () => {}
  let rejectClosed: (error: OrivonError) => void = () => {}
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject })
  // Handled on THIS reference only, for the same reason ./socket-port.ts does
  // it: an app that never touches `closed` must not produce an unhandled
  // rejection on every abrupt close. The main world derives a fresh promise.
  closed.catch(() => {})

  function settleClosed (error?: OrivonError): void {
    if (closedSettled) return
    closedSettled = true
    if (error === undefined) resolveClosed(); else rejectClosed(error)
  }

  function noteDrops (): void {
    droppedCb?.(droppedInbound, droppedOutbound)
  }

  function flushCredit (): void {
    creditFlushScheduled = false
    if (consumedDatagrams <= 0) return
    port.postMessage({
      kind: 'datagram-credit', handleId, datagramsConsumed: consumedDatagrams, bytesConsumed: consumedBytes
    })
    consumedDatagrams = 0
    consumedBytes = 0
  }

  function armSilence (): void {
    if (silenceTimer !== undefined || disposed) return
    silenceTimer = setTimeout(() => {
      silenceTimer = undefined
      // Unlike a TCP write, handing a datagram to the OS never waits on the
      // network -- so silence with sends outstanding is a dead transport, not
      // a slow peer (contracts/ipc.ts's DROP_REPORT_MS note).
      const error = toOrivonError('timeout', { message: 'the datagram port went silent' })
      terminated = true
      fatalCb?.('timeout')
      settleClosed(error)
      releaseAll()
    }, silenceTimeoutMs)
    silenceTimer.unref?.()
  }

  function disarmSilence (): void {
    if (silenceTimer === undefined) return
    clearTimeout(silenceTimer)
    silenceTimer = undefined
  }

  /** Lets queued senders through as the window reopens. */
  function drainWaiting (): void {
    while (outstanding < windowDatagrams && waiting.length > 0) {
      const next = waiting.shift()
      next?.()
    }
  }

  function releaseAll (): void {
    outstanding = 0
    while (waiting.length > 0) waiting.shift()?.()
  }

  function settleOutstanding (count: number): void {
    outstanding = Math.max(0, outstanding - count)
    if (outstanding === 0) disarmSilence()
    drainWaiting()
  }

  port.onMessage((raw) => {
    if (disposed) return
    const message = raw as BrokerToRendererMessage
    switch (message.kind) {
      case 'datagram':
        if (message.dropped > droppedInbound) { droppedInbound = message.dropped; noteDrops() }
        datagramCb?.({
          data: message.data, address: message.address, port: message.port, family: message.family
        })
        break
      case 'datagram-dropped':
        if (message.dropped > droppedInbound) { droppedInbound = message.dropped; noteDrops() }
        break
      case 'send-ack':
        settleOutstanding(message.datagramsAccepted)
        break
      case 'send-failed':
        // COUNTED, NOT THROWN (A87). The send that was refused has already
        // resolved from the app's point of view; all that is left is to
        // release its window slot, move the counter, and tell whoever is
        // listening on `refusals` which destination it was.
        if (message.dropped > droppedOutbound) { droppedOutbound = message.dropped; noteDrops() }
        refusalCb?.({ address: message.address, port: message.port, code: message.code })
        settleOutstanding(1)
        break
      case 'end':
        // A genuine 'end' can arrive after the silence timeout already
        // terminated the port (armSilence's own callback), racing it -- the
        // terminal state and its onReadEnd firing belong to whichever
        // reason got there first, not both.
        if (terminated) break
        terminated = true
        readEndCb?.(message.code)
        settleClosed(message.code === undefined
          ? undefined
          : toOrivonError(message.code, { message: 'the udp socket ended' }))
        releaseAll()
        break
      default:
        // A byte-path message on a datagram port. Ignored, matching the
        // broker relay's own stance -- there is no state it could corrupt.
        break
    }
  })

  return {
    onDatagram (cb) { datagramCb = cb },
    onReadEnd (cb) { readEndCb = cb },
    onDropped (cb) { droppedCb = cb },
    onRefusal (cb) { refusalCb = cb },
    onFatal (cb) { fatalCb = cb },
    closed,
    reportConsumed (datagrams, bytes) {
      if (disposed || datagrams <= 0) return
      consumedDatagrams += datagrams
      consumedBytes += bytes
      // Coalesced by COUNT: this is the credit the broker's window is
      // denominated in, and DATAGRAM_CREDIT_COALESCE is deliberately well
      // below the window so credit is released long before it runs out.
      if (consumedDatagrams >= DATAGRAM_CREDIT_COALESCE) {
        flushCredit()
        return
      }
      if (creditFlushScheduled) return
      creditFlushScheduled = true
      queueMicrotask(flushCredit)
    },
    async send (datagram) {
      if (terminated) return
      if (outstanding >= windowDatagrams) {
        await new Promise<void>((resolve) => { waiting.push(resolve) })
        if (terminated) return
      }
      outstanding += 1
      armSilence()
      port.postMessage({
        kind: 'send', handleId, data: datagram.data, address: datagram.address, port: datagram.port
      })
    },
    dispose () {
      if (disposed) return
      disposed = true
      terminated = true
      disarmSilence()
      releaseAll()
      // An app-initiated close resolves `closed` (handle-contracts.md's close
      // table) rather than leaving it hanging forever now that no 'end'
      // message can ever arrive to settle it locally.
      settleClosed()
    }
  }
}
