// The one function handed to `contextBridge.executeInMainWorld`. SERIALISED
// (Function.prototype.toString) and re-evaluated fresh in the main world,
// so every helper it needs must be declared INSIDE its own body -- no free
// variables, no imports, no module-level consts. That is what makes
// `ReadableStream`/`WritableStream`/`ByteLengthQueuingStrategy` inside it
// the PAGE's own constructors, not the preload's isolated-world ones --
// contextBridge copies plain values across, but a stream built in the
// isolated world crosses broken, which is the whole reason this exists
// rather than building streams directly in ./socket-port.ts.
//
// `bridge` is a plain object of proxied closures orivon-surface.ts built:
// one per app.manifest/app.grants/fs.readFile/fs.writeFile/id.publicKey/
// id.sign, plus `netConnect`, resolving to a per-socket bag shaped like
// ./socket-port.ts's own SocketPort plus the connection descriptor and the
// three control-channel operations (close/setNoDelay/setKeepAlive)
// net.connect doesn't otherwise expose.
//
// `target` defaults to the real `window` (this runs IN the main world) but
// is overridable, the same pattern src/shim/globals.ts uses for the same
// reason: never mutate the one real global environment a whole test run
// shares.

import type { OrivonErrorCode } from '../contracts/errors.js'
import type { SendRefusal, UdpSocket } from '../contracts/handles.js'

export interface OrivonLimits {
  readonly readWindowBytes: number
  readonly writeWindowBytes: number
  readonly inboundDatagramWindow: number
  readonly outboundDatagramWindow: number
}

/** One UDP packet, as the page sees it. Mirrors contracts/handles.ts's Datagram. */
export interface MainWorldDatagram {
  readonly data: Uint8Array
  readonly address: string
  readonly port: number
  readonly family: 'IPv4' | 'IPv6'
}

/**
 * What orivon-surface.ts's netUdpBind closure resolves to -- ./datagram-port.ts's
 * DatagramPort plus the bind descriptor and the one control-channel operation
 * a UDP socket has (close).
 *
 * `onDropped` is PUSH-BASED rather than a pair of getters, and that is not a
 * style choice: a value returned synchronously across contextBridge's proxy is
 * unproven on this path, while sync-void calls with callbacks are exactly what
 * the rest of this bridge already does and what the 2026-09-05 probe confirmed.
 */
export interface MainWorldUdpBridge {
  readonly id: string
  readonly localAddress: string
  readonly localPort: number
  readonly onDatagram: (cb: (datagram: MainWorldDatagram) => void) => void
  readonly onReadEnd: (cb: (code: OrivonErrorCode | undefined) => void) => void
  readonly onDropped: (cb: (inbound: number, outbound: number) => void) => void
  /** Fires once per refused outbound datagram (A87), feeding buildUdpSocket's `refusals` stream. */
  readonly onRefusal: (cb: (refusal: SendRefusal) => void) => void
  readonly onFatal: (cb: (code: OrivonErrorCode) => void) => void
  readonly reportConsumed: (datagrams: number, bytes: number) => void
  readonly send: (datagram: MainWorldDatagram) => Promise<void>
  readonly closed: Promise<void>
  readonly close: () => Promise<void>
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
  /** Fires once if the write direction fails outright, or the port goes silent past the timeout -- see ./socket-port.ts's own SocketPort.onFatal. */
  readonly onFatal: (cb: (code: OrivonErrorCode) => void) => void
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
    /** ADR-0016's one synchronous call -- see orivon-surface.ts's own fsReadFileSync for the mechanism. Deliberately NOT `Promise<Uint8Array>` like every other bridge closure here. */
    fsReadFileSync: (path: string) => Uint8Array
    idPublicKey: (curve: string) => Promise<Uint8Array>
    idSign: (curve: string, payload: Uint8Array) => Promise<Uint8Array>
    netConnect: (opts: { host: string, port: number }) => Promise<MainWorldSocketBridge>
    netUdpBind: (opts: { port: number }) => Promise<MainWorldUdpBridge>
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
    let readController: ReadableStreamDefaultController<Uint8Array>
    let writeController: WritableStreamDefaultController

    const readable = new ReadableStream<Uint8Array>({
      start (controller) {
        readController = controller
        s.onData((chunk) => {
          totalEnqueued += chunk.byteLength
          controller.enqueue(chunk)
        })
        s.onReadEnd((code) => {
          if (code === undefined) {
            controller.close()
          } else {
            // An abrupt read-end means no more writes will ever be accepted
            // either -- error BOTH sides, not just the one this callback owns.
            const error = toOrivonError(code)
            controller.error(error)
            try { writeController.error(error) } catch { /* already settled */ }
          }
        })
      },
      pull (controller) {
        // ByteLengthQueuingStrategy's own desiredSize = highWaterMark - the
        // queue's current total byte size, so the queue's current size is
        // recoverable from it without this file tracking anything the
        // platform already tracks. The delta since the last pull() is what
        // the app has genuinely drained since credit was last reported.
        // desiredSize is null once the controller is no longer readable --
        // falling back to 0 (not readWindowBytes) means crediting NOTHING in
        // that case, never the whole window for bytes that may be unread.
        const desiredSize = controller.desiredSize ?? 0
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
      start (controller) { writeController = controller },
      write: async (chunk) => { await s.write(chunk) },
      close: async () => { await s.endWrite() },
      abort: () => { s.abortWrite() }
    }, new ByteLengthQueuingStrategy({ highWaterMark: limits.writeWindowBytes }))

    s.onFatal((code) => {
      const error = toOrivonError(code)
      try { readController.error(error) } catch { /* already settled */ }
      try { writeController.error(error) } catch { /* already settled */ }
    })

    return Object.freeze({
      id: s.id,
      remoteAddress: s.remoteAddress,
      remotePort: s.remotePort,
      localAddress: s.localAddress,
      localPort: s.localPort,
      readable,
      writable,
      // A fresh promise, not s.closed itself -- see installOrivon's own
      // isolated-world counterpart (socket-port.ts's createSocketPort),
      // which deliberately hands out a wrapper for the same reason.
      closed: new Promise<void>((resolve, reject) => { s.closed.then(resolve, reject) }),
      close: async () => {
        await s.close()
        // Reflect the closure on both WHATWG streams the page holds --
        // ReadableStreamDefaultController has no other externally callable
        // terminal state, and error() is the closest WritableStream has to
        // an externally-triggered close (it has no controller.close()).
        try { readController.close() } catch { /* already closed or errored */ }
        try { writeController.error(toOrivonError('closed')) } catch { /* already settled */ }
      },
      setNoDelay: async (on: boolean) => { await s.setNoDelay(on) },
      setKeepAlive: async (on: boolean, initialDelayMs?: number) => { await s.setKeepAlive(on, initialDelayMs) }
    })
  }

  function buildUdpSocket (u: Awaited<ReturnType<typeof bridge.netUdpBind>>): UdpSocket {
    let droppedInbound = 0
    let droppedOutbound = 0
    let readController: ReadableStreamDefaultController<MainWorldDatagram>
    let writeController: WritableStreamDefaultController
    let refusalController: ReadableStreamDefaultController<SendRefusal>

    // Enqueued but not yet drained, oldest first. A CountQueuingStrategy makes
    // the QUEUE's length recoverable from desiredSize, but the broker's credit
    // window is denominated in both datagrams AND bytes -- so the byte figure
    // has to come from somewhere, and the sizes of the datagrams that actually
    // left the queue is the only honest source for it.
    const queuedSizes: number[] = []
    let enqueued = 0
    let consumedTotal = 0

    u.onDropped((inbound, outbound) => {
      droppedInbound = inbound
      droppedOutbound = outbound
    })

    const readable = new ReadableStream<MainWorldDatagram>({
      start (controller) {
        readController = controller
        u.onDatagram((datagram) => {
          enqueued += 1
          queuedSizes.push(datagram.data.byteLength)
          controller.enqueue(datagram)
        })
        u.onReadEnd((code) => {
          if (code === undefined) {
            try { controller.close() } catch { /* already settled */ }
            try { refusalController.close() } catch { /* already settled */ }
          } else {
            const error = toOrivonError(code)
            try { controller.error(error) } catch { /* already settled */ }
            try { writeController.error(error) } catch { /* already settled */ }
            try { refusalController.error(error) } catch { /* already settled */ }
          }
        })
      },
      pull (controller) {
        // Same derivation as buildSocket's, counted rather than measured:
        // desiredSize is null once the controller is no longer readable, and
        // falling back to 0 credits NOTHING rather than the whole window.
        const desiredSize = controller.desiredSize ?? 0
        const queueLength = limits.inboundDatagramWindow - desiredSize
        const delta = (enqueued - queueLength) - consumedTotal
        if (delta > 0) {
          consumedTotal += delta
          let bytes = 0
          for (const size of queuedSizes.splice(0, delta)) bytes += size
          u.reportConsumed(delta, bytes)
        }
      }
    }, new CountQueuingStrategy({ highWaterMark: limits.inboundDatagramWindow }))

    const writable = new WritableStream<MainWorldDatagram>({
      start (controller) { writeController = controller },
      // A datagram the broker REFUSED still resolves here. Rejecting would
      // error this stream permanently, and a peer list outside the grant is
      // ordinary traffic for a P2P app -- the refusal shows up in
      // droppedOutbound instead (open-questions.md A87).
      write: async (datagram) => { await u.send(datagram) },
      close: async () => { await u.close() },
      abort: async () => { await u.close() }
    }, new CountQueuingStrategy({ highWaterMark: limits.outboundDatagramWindow }))

    // Fed by u.onRefusal (A87): every outbound datagram the broker refused,
    // reported here instead of by rejecting `writable`'s sink -- a refused
    // destination is ordinary P2P traffic and must not error the socket.
    // Unlike `readable`, no wire-level credit window paces this: the broker
    // reports a refusal as soon as it happens, with nothing pacing it against
    // what this stream has drained. `droppedOutbound` above already counts
    // every refusal regardless, so once the queue is full a new one is
    // DROPPED here rather than queued without bound.
    const refusals = new ReadableStream<SendRefusal>({
      start (controller) {
        refusalController = controller
        u.onRefusal((refusal) => {
          if ((controller.desiredSize ?? 0) <= 0) return
          controller.enqueue(refusal)
        })
      }
    }, new CountQueuingStrategy({ highWaterMark: limits.outboundDatagramWindow }))

    u.onFatal((code) => {
      const error = toOrivonError(code)
      try { readController.error(error) } catch { /* already settled */ }
      try { writeController.error(error) } catch { /* already settled */ }
      try { refusalController.error(error) } catch { /* already settled */ }
    })

    return Object.freeze({
      id: u.id,
      localAddress: u.localAddress,
      localPort: u.localPort,
      readable,
      writable,
      refusals,
      // GETTERS, not values: these move for the life of the socket, and a
      // number copied once at acquisition would read zero forever. Object.freeze
      // prevents redefinition, not invocation, so both survive it.
      get droppedInbound () { return droppedInbound },
      get droppedOutbound () { return droppedOutbound },
      closed: new Promise<void>((resolve, reject) => { u.closed.then(resolve, reject) }),
      close: async () => {
        await u.close()
        try { readController.close() } catch { /* already closed or errored */ }
        try { writeController.error(toOrivonError('closed')) } catch { /* already settled */ }
        try { refusalController.close() } catch { /* already closed or errored */ }
      }
    })
  }

  const api = {
    version: 0,
    app: Object.freeze({
      manifest: async () => await bridge.appManifest(),
      grants: async () => await bridge.appGrants()
    }),
    fs: Object.freeze({
      readFile: async (path: string) => await bridge.fsReadFile(path),
      writeFile: async (path: string, data: Uint8Array) => { await bridge.fsWriteFile(path, data) },
      // NOT wrapped in `async` -- whether this stays synchronous once
      // proxied through `contextBridge.executeInMainWorld` is exactly the
      // thing only a real launch can settle (see this lane's PR body); an
      // `async` wrapper here would force a Promise even if the proxy itself
      // preserved a synchronous return, hiding the answer either way.
      readFileSync: (path: string) => bridge.fsReadFileSync(path)
    }),
    id: Object.freeze({
      publicKey: async (opts: { curve: string }) => await bridge.idPublicKey(opts.curve),
      sign: async (opts: { curve: string, payload: Uint8Array }) => await bridge.idSign(opts.curve, opts.payload)
    }),
    net: Object.freeze({
      connect: async (opts: { host: string, port: number }) => buildSocket(await bridge.netConnect(opts)),
      udpBind: async (opts: { port: number }) => buildUdpSocket(await bridge.netUdpBind(opts))
    })
  }
  // A plain assignment here would let any page script (or a compromised
  // third-party script tag on the same page) replace orivon.net.connect and
  // have every OTHER script transparently use the substitute -- the old
  // exposeInMainWorld path froze what it exposed; this one does not by
  // default.
  Object.defineProperty(target, 'orivon', { value: Object.freeze(api), writable: false, configurable: false, enumerable: true })
}
