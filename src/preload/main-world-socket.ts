// The one function handed to `contextBridge.executeInMainWorld`. SERIALISED
// (Function.prototype.toString) and re-evaluated fresh in the main world, so
// every helper it needs must be declared INSIDE its own body -- no free
// variables, no imports, no module-level consts. That is what makes
// `ReadableStream`/`WritableStream`/`ByteLengthQueuingStrategy` inside it the
// PAGE's own constructors, not the preload's isolated-world ones --
// contextBridge copies plain values across, but a stream built in the
// isolated world crosses broken, which is the whole reason this exists
// rather than building streams directly in ./socket-port.ts. `web.
// openContext` needs none of that (web-surface.ts's header) but stays here
// too: `window.orivon` freezes non-configurable below, nothing bolts on later.
//
// `bridge` is a plain object of proxied closures orivon-surface.ts built,
// one per CONTROL_CHANNEL method; `target` defaults to the real `window`
// (overridable, matching src/shim/globals.ts) so a test never mutates the
// one shared global environment.

import type { OrivonErrorCode } from '../contracts/errors.js'
import type { SendRefusal, UdpSocket } from '../contracts/handles.js'
import type { CapabilityRequest } from '../contracts/capability-api.js'
import type {
  MainWorldBridge, MainWorldDatagram, MainWorldDirectoryBridge, MainWorldFileBridge, MainWorldServerBridge,
  MainWorldSocketBridge, MainWorldUdpBridge, MainWorldWebContextBridge, OrivonLimits
} from './main-world-bridges.js'

// The bridge shapes -- including installOrivon's own `bridge` PARAMETER
// shape, `MainWorldBridge` -- live in ./main-world-bridges.ts, split out
// under code-guidelines.md Rule 2, safe despite this file's own serialised-
// function constraint below since an `interface` produces no JS at all
// (that file's own header). Re-exported so no import site changes.
export type {
  MainWorldBridge, MainWorldDatagram, MainWorldDirectoryBridge, MainWorldFileBridge, MainWorldServerBridge,
  MainWorldSocketBridge, MainWorldUdpBridge, MainWorldWebContextBridge, OrivonLimits
} from './main-world-bridges.js'

export function installOrivon (
  bridge: MainWorldBridge,
  limits: OrivonLimits,
  target: { orivon?: unknown } = typeof window === 'undefined' ? {} : window as unknown as { orivon?: unknown }
): void {
  /**
   * UNLIKE ../orivon-error.ts's isolated-world twin, this builds a REAL
   * `Error`, not a plain object -- A152 (docs/open-questions.md). That
   * file's plain object is load-bearing THERE because it still has to
   * cross `contextBridge` (which strips a thrown Error down to its
   * `.message`); everything this copy builds is already past that
   * crossing (onReadEnd/onFatal/close/readFileSync all hand it straight
   * to the page's own stream controllers or throw it directly), so
   * nothing here needs to survive contextBridge a second time, and
   * `OrivonError extends Error` (../../contracts/errors.ts) can actually
   * hold. This file cannot import the isolated-world twin either way
   * (serialised and re-run fresh in the main world; see the file header).
   */
  function toOrivonError (
    code: OrivonErrorCode,
    options: { message?: string, platformCode?: string } = {}
  ): Error & { code: OrivonErrorCode, platformCode?: string } {
    const { message = `orivon: ${code}`, platformCode } = options
    const error = new Error(message) as Error & { code: OrivonErrorCode, platformCode?: string }
    error.name = 'OrivonError'
    error.code = code
    if (platformCode !== undefined) error.platformCode = platformCode
    return error
  }

  /**
   * A `bridge.*` call's rejection crosses `contextBridge`'s own promise-
   * rejection marshalling FROM the isolated world -- ../orivon-error.ts's
   * plain-object choice (see its own header) survives that crossing with
   * every field intact, measured live (A152), but lands here as a fresh
   * plain object in THIS world, so `instanceof Error` is false for it
   * despite the contract promising every OrivonError one is. Rebuilds a
   * real Error from it, entirely inside the main world -- there is no
   * further crossing after this point for anything this function returns.
   * A rejection that does not look like one of ours (no string `.message`
   * or `.code`) passes through unchanged rather than being reshaped.
   */
  async function callRevived<T> (promise: Promise<T>): Promise<T> {
    try {
      return await promise
    } catch (error) {
      if (typeof error !== 'object' || error === null) throw error
      const candidate = error as { name?: unknown, message?: unknown, code?: unknown, platformCode?: unknown }
      if (typeof candidate.message !== 'string' || typeof candidate.code !== 'string') throw error
      const revived = new Error(candidate.message) as Error & { code: string, platformCode?: string }
      revived.name = typeof candidate.name === 'string' ? candidate.name : 'OrivonError'
      revived.code = candidate.code
      if (typeof candidate.platformCode === 'string') revived.platformCode = candidate.platformCode
      throw revived
    }
  }

  /** A page-facing `closed`: revived, and marked handled so an abrupt close the page never listens for raises no `unhandledrejection` -- a page that does listen still sees the rejection. */
  function pageClosed (closed: Promise<void>): Promise<void> {
    const revived = callRevived(closed)
    revived.catch(() => {})
    return revived
  }

  function buildSocket (s: Awaited<ReturnType<typeof bridge.netConnect>>): unknown {
    let totalEnqueued = 0
    let consumedTotal = 0
    let readCancelled = false
    let readController: ReadableStreamDefaultController<Uint8Array>
    let writeController: WritableStreamDefaultController

    const readable = new ReadableStream<Uint8Array>({
      start (controller) {
        readController = controller
        s.onData((chunk) => {
          // A cancelled readable has no queue left: the bytes are dropped and
          // credited at once, so the peer is not stalled by bytes nobody reads.
          if (readCancelled) { s.reportConsumed(chunk.byteLength); return }
          totalEnqueued += chunk.byteLength
          controller.enqueue(chunk)
        })
        s.onReadEnd((code, platformCode?: string) => {
          if (readCancelled) return
          if (code === undefined) {
            controller.close()
          } else {
            // An abrupt read-end means no more writes will ever be accepted
            // either -- error BOTH sides, not just the one this callback owns.
            const error = toOrivonError(code, platformCode === undefined ? {} : { platformCode })
            controller.error(error)
            try { writeController.error(error) } catch { /* already settled */ }
          }
        })
      },
      cancel () { readCancelled = true },
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
      write: async (chunk) => { await callRevived(s.write(chunk)) },
      close: async () => { await callRevived(s.endWrite()) },
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
      closed: pageClosed(s.closed),
      close: async () => {
        await callRevived(s.close())
        // Reflect the closure on both WHATWG streams the page holds --
        // ReadableStreamDefaultController has no other externally callable
        // terminal state, and error() is the closest WritableStream has to
        // an externally-triggered close (it has no controller.close()).
        try { readController.close() } catch { /* already closed or errored */ }
        try { writeController.error(toOrivonError('closed')) } catch { /* already settled */ }
      },
      setNoDelay: async (on: boolean) => { await callRevived(s.setNoDelay(on)) },
      setKeepAlive: async (on: boolean, initialDelayMs?: number) => { await callRevived(s.setKeepAlive(on, initialDelayMs)) }
    })
  }

  /**
   * Builds the page's real `TcpServer` (contracts/handles.ts) -- the
   * `connections` half of A114/d-0028, over exactly the closures
   * ./server-port.ts built in the isolated world.
   *
   * `highWaterMark: 0`, MATCHING THE BROKER'S OWN `entry.connections`
   * EXACTLY (handle-contracts.md's "TcpServer" section, net-capability.ts's
   * own `listen`): `pull()` below fires once per app `read()` that finds the
   * queue empty, and each firing is EXACTLY one unit of accept demand
   * (./server-port.ts's `reportAccepted`, ../broker/transport/accept-pump.ts's
   * own `handleDemand` one layer down). THIS IS THE PROPERTY THIS WHOLE LANE
   * EXISTS TO PRESERVE: `reportAccepted` must never be called from anywhere
   * but here, or the broker accepts connections nobody asked for
   * (open-questions.md A185).
   */
  function buildServer (s: Awaited<ReturnType<typeof bridge.netListen>>): unknown {
    let readController: ReadableStreamDefaultController<unknown>

    const connections = new ReadableStream({
      start (controller) {
        readController = controller
        s.onConnection((socket) => { controller.enqueue(buildSocket(socket)) })
        s.onReadEnd((code) => {
          if (code === undefined) {
            try { controller.close() } catch { /* already settled */ }
          } else {
            try { controller.error(toOrivonError(code)) } catch { /* already settled */ }
          }
        })
      },
      pull () {
        s.reportAccepted()
      }
    }, new CountQueuingStrategy({ highWaterMark: 0 }))

    return Object.freeze({
      id: s.id,
      localAddress: s.localAddress,
      localPort: s.localPort,
      connections,
      closed: pageClosed(s.closed),
      close: async () => {
        await callRevived(s.close())
        try { readController.close() } catch { /* already closed or errored */ }
      }
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
      write: async (datagram) => { await callRevived(u.send(datagram)) },
      close: async () => { await callRevived(u.close()) },
      abort: async () => { await callRevived(u.close()) }
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
      closed: pageClosed(u.closed),
      close: async () => {
        await callRevived(u.close())
        try { readController.close() } catch { /* already closed or errored */ }
        try { writeController.error(toOrivonError('closed')) } catch { /* already settled */ }
        try { refusalController.close() } catch { /* already closed or errored */ }
      }
    })
  }

  /**
   * `fsOpen`'s own counterpart to `buildSocket`/`buildUdpSocket` -- far
   * simpler, because every method here is a plain request/reply round trip
   * with no port and no stream to build. Each nested closure still needs
   * its own `callRevived`: `f.read`/`f.write`/... each cross back into the
   * isolated world independently, and any one of them can reject on its own.
   */
  function buildFile (f: Awaited<ReturnType<typeof bridge.fsOpen>>): MainWorldFileBridge {
    return Object.freeze({
      id: f.id,
      read: async (opts: { position: number, length: number }) => await callRevived(f.read(opts)),
      write: async (opts: { position: number, data: Uint8Array }) => await callRevived(f.write(opts)),
      stat: async () => await callRevived(f.stat()),
      truncate: async (length: number) => { await callRevived(f.truncate(length)) },
      sync: async () => { await callRevived(f.sync()) },
      close: async () => { await callRevived(f.close()) }
    })
  }

  /** `buildFile`'s own web.openContext counterpart (ADR-0019) -- `closed` is already live by the time it crosses here (web-surface.ts's watchClose), so `pageClosed` is all it needs, same as `s.closed` in `buildSocket`. */
  function buildWebContext (w: Awaited<ReturnType<typeof bridge.webOpenContext>>): MainWorldWebContextBridge {
    return Object.freeze({
      id: w.id, origin: w.origin, closed: pageClosed(w.closed),
      evaluate: async (script: string) => await callRevived(w.evaluate(script)),
      close: async () => { await callRevived(w.close()) }
    })
  }

  /** `buildFile`'s own DirectoryHandle counterpart (A195) -- `open` reuses `buildFile` on whatever it resolves, so a folder-opened file gets the identical wrapped shape `orivon.fs.open()` itself would hand it. */
  function buildDirectory (d: MainWorldDirectoryBridge): MainWorldDirectoryBridge {
    return Object.freeze({
      id: d.id,
      readdir: async (path?: string) => await callRevived(d.readdir(path)),
      stat: async (path?: string) => await callRevived(d.stat(path)),
      mkdir: async (path: string, opts?: { recursive?: boolean }) => { await callRevived(d.mkdir(path, opts)) },
      rm: async (path: string, opts?: { recursive?: boolean }) => { await callRevived(d.rm(path, opts)) },
      rename: async (from: string, to: string) => { await callRevived(d.rename(from, to)) },
      readFile: async (path: string) => await callRevived(d.readFile(path)),
      writeFile: async (path: string, data: Uint8Array) => { await callRevived(d.writeFile(path, data)) },
      open: async (path: string, flags: string) => buildFile(await callRevived(d.open(path, flags))),
      close: async () => { await callRevived(d.close()) }
    })
  }

  const api = {
    version: 0,
    app: Object.freeze({
      manifest: async () => await callRevived(bridge.appManifest()),
      grants: async () => await callRevived(bridge.appGrants()),
      requestGrant: async (request: CapabilityRequest) => await callRevived(bridge.appRequestGrant(request))
    }),
    fs: Object.freeze({
      readFile: async (path: string) => await callRevived(bridge.fsReadFile(path)),
      writeFile: async (path: string, data: Uint8Array) => { await callRevived(bridge.fsWriteFile(path, data)) },
      // NOT wrapped in `async` -- confirmed live (a real Electron launch)
      // to stay genuinely synchronous once proxied through
      // `contextBridge.executeInMainWorld`; an `async` wrapper here would
      // force a Promise even though the proxy itself does not.
      // `bridge.fsReadFileSync` never throws (see its own doc on why); the
      // failure branch is built and thrown HERE instead, entirely inside
      // this main-world function, so the throw itself never has to cross
      // the proxy boundary that strips a thrown value's shape. No
      // callRevived here either -- this never goes through a `bridge.*`
      // rejection at all.
      readFileSync: (path: string) => {
        const response = bridge.fsReadFileSync(path)
        if (response.ok) return response.result
        throw toOrivonError(response.code, response.platformCode === undefined
          ? { message: response.message }
          : { message: response.message, platformCode: response.platformCode })
      },
      mkdir: async (path: string, opts?: { recursive?: boolean }) => { await callRevived(bridge.fsMkdir(path, opts)) },
      readdir: async (path: string) => await callRevived(bridge.fsReaddir(path)),
      stat: async (path: string) => await callRevived(bridge.fsStat(path)),
      rm: async (path: string, opts?: { recursive?: boolean }) => { await callRevived(bridge.fsRm(path, opts)) },
      rename: async (from: string, to: string) => { await callRevived(bridge.fsRename(from, to)) },
      open: async (path: string, flags: string) => buildFile(await callRevived(bridge.fsOpen(path, flags))),
      // Routes on `opts?.directory`, matching capability-api.ts's own overload split (A195).
      userSelected: async (opts?: { directory?: boolean, multiple?: boolean }) => {
        if (opts?.directory === true) {
          const dir = await callRevived(bridge.fsUserSelectedDirectory())
          return dir === null ? null : buildDirectory(dir)
        }
        const fileOpts = opts?.multiple === undefined ? undefined : { multiple: opts.multiple }
        return (await callRevived(bridge.fsUserSelected(fileOpts))).map(buildFile)
      }
    }),
    id: Object.freeze({
      publicKey: async (opts: { curve: string }) => await callRevived(bridge.idPublicKey(opts.curve)),
      sign: async (opts: { curve: string, payload: Uint8Array }) => await callRevived(bridge.idSign(opts.curve, opts.payload))
    }),
    web: Object.freeze({
      openContext: async (origin: string, options?: { width?: number, height?: number }) => buildWebContext(await callRevived(bridge.webOpenContext({ origin, ...options })))
    }),
    net: Object.freeze({
      connect: async (opts: { host: string, port: number }) => buildSocket(await callRevived(bridge.netConnect(opts))),
      connectSecure: async (opts: { host: string, port: number }) => buildSocket(await callRevived(bridge.netConnectSecure(opts))),
      udpBind: async (opts: { port: number }) => buildUdpSocket(await callRevived(bridge.netUdpBind(opts))),
      listen: async (opts: { port: number }) => buildServer(await callRevived(bridge.netListen(opts))),
      lookup: async (opts: { hostname: string }) => await callRevived(bridge.netLookup(opts))
    })
  }
  // A plain assignment here would let any page script (or a compromised
  // third-party script tag on the same page) replace orivon.net.connect and
  // have every OTHER script transparently use the substitute -- the old
  // exposeInMainWorld path froze what it exposed; this one does not by
  // default.
  Object.defineProperty(target, 'orivon', { value: Object.freeze(api), writable: false, configurable: false, enumerable: true })
}
