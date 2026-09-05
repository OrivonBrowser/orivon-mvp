// The one function handed to `contextBridge.executeInMainWorld`. It is
// SERIALISED (Function.prototype.toString) and re-evaluated fresh in the
// main world, so every helper it needs must be declared INSIDE its own
// body -- no free variables, no imports, no module-level consts. This is
// what makes `ReadableStream`/`WritableStream`/`ByteLengthQueuingStrategy`
// inside it resolve to the PAGE's own constructors rather than the
// preload's isolated-world ones, which is the entire reason this function
// exists rather than building the streams in ./socket-port.ts directly
// (contextBridge copies plain values across, but a stream built in the
// isolated world would cross broken -- see the design note this PR's body
// links).
//
// `bridge` is a plain object of proxied closures the preload built (see
// orivon-surface.ts): one per app.manifest/app.grants/fs.readFile/
// fs.writeFile, plus `netConnect`, which itself resolves to a per-socket
// bag of closures shaped exactly like ./socket-port.ts's own SocketPort
// (data/read-end/credit/write/end/abort/fatal/closed) plus the connection
// descriptor and the three control-channel operations (close/setNoDelay/
// setKeepAlive) net.connect doesn't otherwise expose.
//
// `target` defaults to the real `window` -- present in production because
// this function runs IN the main world -- but is overridable so a test can
// install onto a throwaway object instead, the same pattern
// src/shim/globals.ts already uses for the same reason (installing onto
// the one real global environment a whole test run shares makes a test
// suite unable to run twice, let alone in parallel).

import type { OrivonErrorCode } from '../contracts/errors.js'

export interface OrivonLimits {
  readonly readWindowBytes: number
  readonly writeWindowBytes: number
}

/** The shape ./socket-port.ts's SocketPort plus a connection descriptor and the three control-channel operations net.connect doesn't otherwise expose -- what orivon-surface.ts's netConnect bridge closure resolves to. */
export interface MainWorldSocketBridge {
  readonly id: string
  readonly remoteAddress: string
  readonly remotePort: number
  readonly localAddress: string
  readonly localPort: number
  readonly onData: (cb: (chunk: Uint8Array) => void) => void
  readonly onReadEnd: (cb: (code: OrivonErrorCode | undefined) => void) => void
  readonly reportConsumed: (bytesConsumed: number) => void
  readonly write: (chunk: Uint8Array) => Promise<void>
  readonly endWrite: () => Promise<void>
  readonly abortWrite: () => void
  readonly closed: Promise<void>
  readonly close: () => Promise<void>
  readonly setNoDelay: (on: boolean) => Promise<void>
  readonly setKeepAlive: (on: boolean, initialDelayMs?: number) => Promise<void>
}

export function installOrivon (
  bridge: {
    appManifest: () => Promise<unknown>
    appGrants: () => Promise<unknown>
    fsReadFile: (path: string) => Promise<Uint8Array>
    fsWriteFile: (path: string, data: Uint8Array) => Promise<void>
    netConnect: (opts: { host: string, port: number }) => Promise<MainWorldSocketBridge>
  },
  limits: OrivonLimits,
  target: { orivon?: unknown } = typeof window === 'undefined' ? {} : window as unknown as { orivon?: unknown }
): void {
  function toOrivonError (code: OrivonErrorCode): { name: string, message: string, code: OrivonErrorCode } {
    return { name: 'OrivonError', message: `orivon: ${code}`, code }
  }

  function buildSocket (s: Awaited<ReturnType<typeof bridge.netConnect>>): unknown {
    let totalEnqueued = 0
    let consumedTotal = 0

    const readable = new ReadableStream<Uint8Array>({
      start (controller) {
        s.onData((chunk) => {
          totalEnqueued += chunk.byteLength
          controller.enqueue(chunk)
        })
        s.onReadEnd((code) => {
          if (code === undefined) controller.close()
          else controller.error(toOrivonError(code))
        })
      },
      pull (controller) {
        // ByteLengthQueuingStrategy's own desiredSize = highWaterMark - the
        // queue's current total byte size, so the queue's current size is
        // recoverable from it without this file tracking anything the
        // platform already tracks. The delta since the last pull() is what
        // the app has genuinely drained since credit was last reported.
        const desiredSize = controller.desiredSize ?? limits.readWindowBytes
        const queueSize = limits.readWindowBytes - desiredSize
        const consumedNow = totalEnqueued - queueSize
        const delta = consumedNow - consumedTotal
        if (delta > 0) {
          consumedTotal = consumedNow
          s.reportConsumed(delta)
        }
      }
    }, new ByteLengthQueuingStrategy({ highWaterMark: limits.readWindowBytes }))

    const writable = new WritableStream<Uint8Array>({
      write: async (chunk) => { await s.write(chunk) },
      close: async () => { await s.endWrite() },
      abort: () => { s.abortWrite() }
    }, new ByteLengthQueuingStrategy({ highWaterMark: limits.writeWindowBytes }))

    return {
      id: s.id,
      remoteAddress: s.remoteAddress,
      remotePort: s.remotePort,
      localAddress: s.localAddress,
      localPort: s.localPort,
      readable,
      writable,
      closed: s.closed,
      close: async () => { await s.close() },
      setNoDelay: async (on: boolean) => { await s.setNoDelay(on) },
      setKeepAlive: async (on: boolean, initialDelayMs?: number) => { await s.setKeepAlive(on, initialDelayMs) }
    }
  }

  target.orivon = {
    version: 0,
    app: {
      manifest: async () => await bridge.appManifest(),
      grants: async () => await bridge.appGrants()
    },
    fs: {
      readFile: async (path: string) => await bridge.fsReadFile(path),
      writeFile: async (path: string, data: Uint8Array) => { await bridge.fsWriteFile(path, data) }
    },
    net: {
      connect: async (opts: { host: string, port: number }) => buildSocket(await bridge.netConnect(opts))
    }
  }
}
