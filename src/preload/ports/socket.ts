import type { OrivonError, OrivonErrorCode } from '../../contracts/errors.js'
import type { BrokerToRendererMessage } from '../../contracts/ipc.js'
import { CREDIT_COALESCE_BYTES, WRITE_SILENCE_TIMEOUT_MS } from '../../contracts/ipc.js'
import { LIMITS } from '../../contracts/limits.js'
import { toOrivonError } from '../orivon-error.js'

// The isolated-world state machine for ONE socket's dedicated port -- the
// preload-side counterpart of ../../broker/transport/relay/port-pump.ts (read) and
// ../../broker/transport/relay/port-sink.ts (write), run from the renderer's end. Pure and
// Electron-free by construction (an injected PortLike, real timers): the
// only Electron-specific piece, listening on ipcRenderer.on(PORT_CHANNEL)
// to obtain a real port in the first place, lives in ./socket-bridge.ts.
//
// NO RENDERER-SIDE WRITE-WINDOW ACCOUNTING HERE, unlike the broker's
// port-sink.ts. The main-world WritableStream this feeds (./main-world-
// socket.ts) is constructed with a ByteLengthQueuingStrategy at
// LIMITS.writeWindowBytes -- the platform's OWN backpressure mechanism
// already gives genuine write-side backpressure for free, and the
// WHATWG spec guarantees the underlying sink's write() (this file's
// `write()`) is never called again before the previous call's promise
// settles. That guarantee is also why `write()` only ever has ONE
// outstanding call to track, not a queue.

export interface PortLike {
  postMessage: (message: unknown) => void
  onMessage: (listener: (message: unknown) => void) => void
  close: () => void
}

/**
 * Adapts a real (DOM) `MessagePort` -- Electron's own conversion of a
 * transferred `MessagePortMain` -- to this file's own `PortLike`. Shared by
 * every per-port state machine in this directory that receives one:
 * ../surface/orivon.ts's netConnect/netConnectSecure/netUdpBind for their own
 * ports, and ./server.ts for each accepted connection's (A114, d-0028)
 * -- code-guidelines.md Rule 3, the adaptation is the same idea regardless of
 * which control method produced the port. Lives here, not in surface/orivon.ts
 * where it was first written, because this file is the one that owns
 * `PortLike` itself.
 */
export function wrapPort (raw: unknown): PortLike {
  const port = raw as MessagePort
  return {
    postMessage: (message) => { port.postMessage(message) },
    // Assigning .onmessage (rather than addEventListener) implicitly starts
    // the port per the WHATWG spec -- no separate port.start() needed.
    onMessage: (listener) => { port.onmessage = (event) => { listener(event.data) } },
    close: () => { port.close() }
  }
}

export interface SocketPortOptions {
  readonly handleId: string
  readonly port: PortLike
  /** WRITE_SILENCE_TIMEOUT_MS in production; overridable in tests. */
  readonly silenceTimeoutMs?: number
}

export interface SocketPort {
  /** The one data callback -- fired for every DataMessage, in order. */
  onData: (cb: (chunk: Uint8Array) => void) => void
  /** Fires once, when the read side reaches a terminal state; `platformCode` only accompanies an errored end. */
  onReadEnd: (cb: (code: OrivonErrorCode | undefined, platformCode?: string) => void) => void
  /** The consumer reports bytes it has drained; coalesced into CreditMessages. */
  reportConsumed: (bytesConsumed: number) => void

  /** Queues one chunk. Resolves once fully accepted; rejects on failure, abort, or silence. */
  write: (chunk: Uint8Array) => Promise<void>
  /** Sends write-end (FIN). The WHATWG close() ordering guarantee means no write is ever pending when this runs. */
  endWrite: () => Promise<void>
  /** Sends write-abort (RST) and rejects whatever write is pending with 'reset'. */
  abortWrite: () => void

  /** Fires once if the write direction fails outright (write-failed) or the port goes silent past the timeout. */
  onFatal: (cb: (code: OrivonErrorCode) => void) => void

  /**
   * Resolves once BOTH directions have reached a clean terminal state
   * (handle-contracts.md's "Common shape" / "TcpSocket" close table);
   * rejects immediately -- without waiting for the other direction -- the
   * moment either one reaches an ABRUPT one (an errored read end,
   * write-failed, abortWrite, or the silence timeout). Every error row in
   * the close table has both sides erroring together, so there is nothing
   * to wait for once one has.
   */
  readonly closed: Promise<void>

  /** Local cleanup only -- stops the timer and the message listener. Sends nothing. */
  dispose: () => void
}

export function createSocketPort (options: SocketPortOptions): SocketPort {
  const { handleId, port, silenceTimeoutMs = WRITE_SILENCE_TIMEOUT_MS } = options

  let dataCb: ((chunk: Uint8Array) => void) | undefined
  let readEndCb: ((code: OrivonErrorCode | undefined, platformCode?: string) => void) | undefined
  let fatalCb: ((code: OrivonErrorCode) => void) | undefined

  let sinceLastCredit = 0
  let creditFlushScheduled = false

  let pendingWrite: { length: number, acceptedSoFar: number, resolve: () => void, reject: (error: OrivonError) => void } | undefined
  let silenceTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  let readTerminal = false
  let writeTerminal = false
  let closedSettled = false
  let resolveClosed: () => void = () => {}
  let rejectClosed: (error: OrivonError) => void = () => {}
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject })
  // Handled on THIS reference only, so an app that never touches `closed`
  // itself doesn't produce a Node/V8 unhandled-rejection warning on every
  // abrupt close. main-world-socket.ts derives a fresh promise off this
  // one for the page, so a real rejection is still observable there.
  closed.catch(() => {})

  function tryResolveClosed (): void {
    if (closedSettled || !readTerminal || !writeTerminal) return
    closedSettled = true
    resolveClosed()
  }
  function forceRejectClosed (error: OrivonError): void {
    if (closedSettled) return
    closedSettled = true
    rejectClosed(error)
  }

  function flushCredit (): void {
    creditFlushScheduled = false
    if (sinceLastCredit <= 0) return
    port.postMessage({ kind: 'credit', handleId, bytesConsumed: sinceLastCredit })
    sinceLastCredit = 0
  }

  function clearSilenceTimer (): void {
    if (silenceTimer !== undefined) { clearTimeout(silenceTimer); silenceTimer = undefined }
  }

  // Armed only while a write is actually outstanding. The broker's
  // own heartbeat (port-sink.ts's armHeartbeat) is a no-op on an idle
  // socket, so resetting this on every inbound message -- including a
  // 'data' chunk with no write pending -- would fire 'timeout' on an
  // ordinary quiet spell: a choked BitTorrent peer's own keepalive is 120s,
  // well past WRITE_SILENCE_TIMEOUT_MS.
  function resetSilenceTimer (): void {
    clearSilenceTimer()
    if (disposed) return
    silenceTimer = setTimeout(() => {
      const error = toOrivonError('timeout')
      pendingWrite?.reject(error)
      pendingWrite = undefined
      fatalCb?.('timeout')
      forceRejectClosed(error)
    }, silenceTimeoutMs)
  }

  port.onMessage((raw) => {
    const message = raw as BrokerToRendererMessage
    if (message == null || typeof message !== 'object' || message.handleId !== handleId) return
    switch (message.kind) {
      case 'data':
        dataCb?.(message.chunk)
        break
      case 'end':
        // State first, callback second: a callback that disposes the port
        // must find `closed` already rejected, not resolve it as clean.
        if (message.code === undefined) { readTerminal = true; tryResolveClosed() } else {
          forceRejectClosed(toOrivonError(message.code, message.platformCode === undefined ? {} : { platformCode: message.platformCode }))
        }
        readEndCb?.(message.code, message.platformCode)
        break
      case 'write-ack':
        if (pendingWrite !== undefined) {
          pendingWrite.acceptedSoFar += message.bytesAccepted
          if (pendingWrite.acceptedSoFar >= pendingWrite.length) {
            clearSilenceTimer()
            pendingWrite.resolve()
            pendingWrite = undefined
          } else {
            resetSilenceTimer() // a heartbeat (possibly zero-byte) on a still-outstanding write
          }
        }
        break
      case 'write-failed': {
        // exactOptionalPropertyTypes: an explicit `platformCode: undefined`
        // is not the same as omitting the key.
        const error = toOrivonError(message.code, message.platformCode === undefined ? {} : { platformCode: message.platformCode })
        clearSilenceTimer()
        pendingWrite?.reject(error)
        pendingWrite = undefined
        fatalCb?.(message.code)
        forceRejectClosed(error)
        break
      }
      // Every datagram-domain kind, plus AcceptedMessage, never flows on a
      // per-connection TCP port: the first four belong to
      // ../../broker/transport/relay/datagram.ts's own port, and AcceptedMessage
      // only ever flows on a TcpServer's OWN dedicated port
      // (contracts/ipc.ts's own header on AcceptedMessage). Reachable here
      // only if something upstream is badly confused -- listed explicitly,
      // not folded into a bare default, so TypeScript narrows `message` to
      // `never` below and the NEXT new BrokerToRendererMessage member landing
      // here unhandled is a compile error rather than the silent gap A114
      // found (open-questions.md A167/A185).
      case 'datagram':
      case 'datagram-dropped':
      case 'send-ack':
      case 'send-failed':
      case 'accepted':
        break
      default: {
        const exhaustive: never = message
        void exhaustive
      }
    }
  })

  // One outstanding WriteMessage at a time, matching the single-pendingWrite
  // state machine (guarded explicitly rather than only trusting the
  // main-world WritableStream's own re-entrancy guarantee -- see the header).
  function sendOneWrite (chunk: Uint8Array): Promise<void> {
    if (disposed) return Promise.reject(toOrivonError('closed'))
    if (pendingWrite !== undefined) return Promise.reject(toOrivonError('invalid', { message: 'a write is already pending on this socket' }))
    // Structured clone copies a view's WHOLE underlying buffer, so a small
    // view over a large buffer (every piece of a split write) is copied out
    // first, or each piece would carry the entire parent across.
    const own = chunk.byteLength < chunk.buffer.byteLength ? chunk.slice() : chunk
    return new Promise<void>((resolve, reject) => {
      pendingWrite = { length: own.byteLength, acceptedSoFar: 0, resolve, reject }
      resetSilenceTimer()
      port.postMessage({ kind: 'write', handleId, chunk: own })
    })
  }

  return {
    onData (cb) { dataCb = cb },
    onReadEnd (cb) { readEndCb = cb },
    reportConsumed (bytesConsumed) {
      if (!Number.isFinite(bytesConsumed) || bytesConsumed < 0) return // never credit a malformed report
      sinceLastCredit += bytesConsumed
      if (sinceLastCredit >= CREDIT_COALESCE_BYTES) {
        flushCredit()
        return
      }
      // A macrotask, deliberately NOT requestAnimationFrame -- rAF does not
      // fire in a backgrounded tab, and a torrent download sitting in a
      // background tab is the ordinary case, not an edge one. Coalescing
      // must never depend on the tab being visible.
      if (!creditFlushScheduled) {
        creditFlushScheduled = true
        setTimeout(flushCredit, 0)
      }
    },
    // d-0021: a chunk over LIMITS.writeWindowBytes kills the connection at
    // the broker outright, so it is split into sequential pieces here --
    // each one fully accepted before the next is sent, since sendOneWrite
    // (and the single-pendingWrite state machine underneath it) only ever
    // tracks one outstanding WriteMessage.
    async write (chunk) {
      if (chunk.byteLength <= LIMITS.writeWindowBytes) {
        await sendOneWrite(chunk)
        return
      }
      let offset = 0
      while (offset < chunk.byteLength) {
        const end = Math.min(offset + LIMITS.writeWindowBytes, chunk.byteLength)
        await sendOneWrite(chunk.subarray(offset, end))
        offset = end
      }
    },
    async endWrite () {
      port.postMessage({ kind: 'write-end', handleId })
      writeTerminal = true
      tryResolveClosed()
    },
    abortWrite () {
      port.postMessage({ kind: 'write-abort', handleId })
      clearSilenceTimer()
      const error = toOrivonError('reset')
      pendingWrite?.reject(error)
      pendingWrite = undefined
      forceRejectClosed(error)
    },
    onFatal (cb) { fatalCb = cb },
    closed,
    dispose () {
      disposed = true
      clearSilenceTimer()
      // An app-initiated close resolves `closed` (handle-contracts.md's
      // close table) rather than leaving it, and any write still in flight,
      // hanging forever now that no ack or timeout can ever reach it.
      if (pendingWrite !== undefined) {
        pendingWrite.reject(toOrivonError('closed'))
        pendingWrite = undefined
      }
      port.close()
      readTerminal = true
      writeTerminal = true
      tryResolveClosed()
    }
  }
}
