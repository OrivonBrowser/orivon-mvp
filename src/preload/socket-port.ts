import type { OrivonError, OrivonErrorCode } from '../contracts/errors.js'
import type { BrokerToRendererMessage } from '../contracts/ipc.js'
import { CREDIT_COALESCE_BYTES, WRITE_SILENCE_TIMEOUT_MS } from '../contracts/ipc.js'

// The isolated-world state machine for ONE socket's dedicated port -- the
// preload-side counterpart of ../broker/port-pump.ts (read) and
// ../broker/port-sink.ts (write), run from the renderer's end. Pure and
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

export interface SocketPortOptions {
  readonly handleId: string
  readonly port: PortLike
  /** WRITE_SILENCE_TIMEOUT_MS in production; overridable in tests. */
  readonly silenceTimeoutMs?: number
}

export interface SocketPort {
  /** The one data callback -- fired for every DataMessage, in order. */
  onData: (cb: (chunk: Uint8Array) => void) => void
  /** Fires once, when the read side reaches a terminal state. */
  onReadEnd: (cb: (code: OrivonErrorCode | undefined) => void) => void
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

  /** Local cleanup only -- stops the timer and the message listener. Sends nothing. */
  dispose: () => void
}

function toOrivonError (code: OrivonErrorCode, platformCode?: string): OrivonError {
  const base = { name: 'OrivonError', message: `write failed: ${code}`, code }
  return platformCode === undefined ? base : { ...base, platformCode }
}

export function createSocketPort (options: SocketPortOptions): SocketPort {
  const { handleId, port, silenceTimeoutMs = WRITE_SILENCE_TIMEOUT_MS } = options

  let dataCb: ((chunk: Uint8Array) => void) | undefined
  let readEndCb: ((code: OrivonErrorCode | undefined) => void) | undefined
  let fatalCb: ((code: OrivonErrorCode) => void) | undefined

  let sinceLastCredit = 0
  let creditFlushScheduled = false

  let pendingWrite: { length: number, acceptedSoFar: number, resolve: () => void, reject: (error: OrivonError) => void } | undefined
  let silenceTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  function flushCredit (): void {
    creditFlushScheduled = false
    if (sinceLastCredit <= 0) return
    port.postMessage({ kind: 'credit', handleId, bytesConsumed: sinceLastCredit })
    sinceLastCredit = 0
  }

  function resetSilenceTimer (): void {
    if (silenceTimer !== undefined) clearTimeout(silenceTimer)
    if (disposed) return
    silenceTimer = setTimeout(() => {
      pendingWrite?.reject(toOrivonError('timeout'))
      pendingWrite = undefined
      fatalCb?.('timeout')
    }, silenceTimeoutMs)
  }

  port.onMessage((raw) => {
    const message = raw as BrokerToRendererMessage
    if (message == null || typeof message !== 'object' || message.handleId !== handleId) return
    resetSilenceTimer()
    switch (message.kind) {
      case 'data':
        dataCb?.(message.chunk)
        break
      case 'end':
        readEndCb?.(message.code)
        break
      case 'write-ack':
        if (pendingWrite !== undefined) {
          pendingWrite.acceptedSoFar += message.bytesAccepted
          if (pendingWrite.acceptedSoFar >= pendingWrite.length) {
            pendingWrite.resolve()
            pendingWrite = undefined
          }
        }
        break
      case 'write-failed': {
        const error = toOrivonError(message.code, message.platformCode)
        pendingWrite?.reject(error)
        pendingWrite = undefined
        fatalCb?.(message.code)
        break
      }
    }
  })

  return {
    onData (cb) { dataCb = cb },
    onReadEnd (cb) { readEndCb = cb },
    reportConsumed (bytesConsumed) {
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
    write (chunk) {
      return new Promise<void>((resolve, reject) => {
        pendingWrite = { length: chunk.byteLength, acceptedSoFar: 0, resolve, reject }
        resetSilenceTimer()
        port.postMessage({ kind: 'write', handleId, chunk })
      })
    },
    async endWrite () {
      port.postMessage({ kind: 'write-end', handleId })
    },
    abortWrite () {
      port.postMessage({ kind: 'write-abort', handleId })
      pendingWrite?.reject(toOrivonError('reset'))
      pendingWrite = undefined
    },
    onFatal (cb) { fatalCb = cb },
    dispose () {
      disposed = true
      if (silenceTimer !== undefined) clearTimeout(silenceTimer)
      port.close()
    }
  }
}
