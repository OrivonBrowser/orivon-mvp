// The one function handed to `contextBridge.executeInMainWorld`. SERIALISED
// (Function.prototype.toString) and re-evaluated fresh in the main world, so
// every helper it needs -- streams, the caller-attribution check below --
// must be declared INSIDE its own body: no free variables, no imports, no
// module-level consts. See README.md's Design notes for why. `bridge` is a
// plain object of proxied closures surface/orivon.ts built, one per
// CONTROL_CHANNEL method; `target` defaults to the real `window` (overridable, matching src/shim/globals.ts) so a test never mutates the shared global.

import type { OrivonErrorCode } from '../../contracts/errors.js'
import type { SendRefusal, UdpSocket } from '../../contracts/handles.js'
import type { BindScope, CapabilityRequest, SecureConnectOptions } from '../../contracts/capability-api.js'
import type {
  CallSiteMethods, MainWorldBridge, MainWorldDatagram, MainWorldDirectoryBridge, MainWorldFileBridge, MainWorldServerBridge,
  MainWorldSocketBridge, MainWorldUdpBridge, MainWorldWebContextBridge, OrivonLimits
} from './main-world-bridges.js'

// The bridge shapes -- including `bridge`'s own PARAMETER shape,
// MainWorldBridge -- live in ./main-world-bridges.ts (Rule 2: an `interface`
// produces no JS, so this is safe despite the constraint above). Re-exported
// so no import site changes.
export type {
  MainWorldBridge, MainWorldDatagram, MainWorldDirectoryBridge, MainWorldFileBridge, MainWorldServerBridge,
  MainWorldSocketBridge, MainWorldUdpBridge, MainWorldWebContextBridge, OrivonLimits
} from './main-world-bridges.js'

export function installOrivon (
  bridge: MainWorldBridge,
  limits: OrivonLimits,
  target: { orivon?: unknown } = typeof window === 'undefined' ? {} : window as unknown as { orivon?: unknown },
  /** False only where the object never enters a main world (the child host's preload): there is no page frame to attribute a call to, and no script but the preload's own can reach it. README.md's Design notes. */
  attributeCallers = true
): void {
  /** Builds a REAL `Error`, unlike ../orivon-error.ts's isolated-world twin -- see README.md's Design notes for why, and why this file cannot import that one either way. */
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
  /** Rebuilds a real `Error` from a bridge rejection (README.md's Design notes) -- one that does not look like one of ours (no string `.message`/`.code`) passes through unchanged. */
  async function callRevived<T> (promise: Promise<T>): Promise<T> {
    try {
      return await promise
    } catch (error) {
      if (typeof error !== 'object' || error === null) throw error
      const candidate = error as { name?: unknown, message?: unknown, code?: unknown, platformCode?: unknown, handleId?: unknown }
      if (typeof candidate.message !== 'string' || typeof candidate.code !== 'string') throw error
      const revived = new Error(candidate.message) as Error & { code: string, platformCode?: string, handleId?: string }
      revived.name = typeof candidate.name === 'string' ? candidate.name : 'OrivonError'
      revived.code = candidate.code
      if (typeof candidate.platformCode === 'string') revived.platformCode = candidate.platformCode
      if (typeof candidate.handleId === 'string') revived.handleId = candidate.handleId
      throw revived
    }
  }
  /** A page-facing `closed`: revived, and marked handled so an abrupt close the page never listens for raises no `unhandledrejection` -- a page that does listen still sees the rejection. */
  function pageClosed (closed: Promise<void>): Promise<void> {
    const revived = callRevived(closed)
    revived.catch(() => {})
    return revived
  }
  /** A secure socket's handshake facts as plain page properties. The certificate is frozen but its `raw`/`pubkey` bytes cannot be: a non-empty typed array refuses `Object.freeze`. */
  function handshakeFields (tls: NonNullable<MainWorldSocketBridge['tls']>): Record<string, unknown> {
    const cert = tls.peerCertificate
    return {
      authorized: tls.authorized,
      ...(tls.authorizationError === undefined ? {} : { authorizationError: tls.authorizationError }),
      alpnProtocol: tls.alpnProtocol,
      peerCertificate: cert === null ? null : Object.freeze({ ...cert, subject: Object.freeze({ ...cert.subject }), issuer: Object.freeze({ ...cert.issuer }) })
    }
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
          // A cancelled readable has no queue left -- credit dropped bytes at once so the peer is not stalled.
          if (readCancelled) { s.reportConsumed(chunk.byteLength); return }
          totalEnqueued += chunk.byteLength
          controller.enqueue(chunk)
        })
        s.onReadEnd((code, platformCode?: string) => {
          if (readCancelled) return
          if (code === undefined) {
            controller.close()
          } else {
            // An abrupt read-end errors BOTH sides, not just this callback's own.
            const error = toOrivonError(code, platformCode === undefined ? {} : { platformCode })
            controller.error(error)
            try { writeController.error(error) } catch { /* already settled */ }
          }
        })
      },
      cancel () { readCancelled = true },
      pull (controller) {
        // Bytes consumed since the last pull(), derived from desiredSize, never tracked separately -- README.md's Design notes.
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
      ...(s.tls === undefined ? {} : handshakeFields(s.tls)),
      readable,
      writable,
      closed: pageClosed(s.closed),
      close: async () => {
        await callRevived(s.close())
        // Reflects the closure on both streams -- error() is the closest WritableStream has to an externally-triggered close.
        try { readController.close() } catch { /* already closed or errored */ }
        try { writeController.error(toOrivonError('closed')) } catch { /* already settled */ }
      },
      setNoDelay: async (on: boolean) => { await callRevived(s.setNoDelay(on)) },
      setKeepAlive: async (on: boolean, initialDelayMs?: number) => { await callRevived(s.setKeepAlive(on, initialDelayMs)) }
    })
  }

  /** Builds the page's real `TcpServer` (contracts/handles.ts), the `connections` half of A114/d-0028, over the closures ../ports/server.ts built -- `pull()`'s `reportAccepted` invariant: README.md's Design notes. */
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

    // Enqueued but not yet drained, oldest first -- the broker's credit window is denominated in bytes too, and CountQueuingStrategy only recovers the queue's LENGTH from desiredSize.
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
        // Same derivation as buildSocket's pull() (README.md's Design notes), counted rather than measured.
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
      // A broker-REFUSED datagram still resolves here, not rejects -- an out-of-grant peer is ordinary P2P traffic, reported via droppedOutbound instead (A87).
      write: async (datagram) => { await callRevived(u.send(datagram)) },
      close: async () => { await callRevived(u.close()) },
      abort: async () => { await callRevived(u.close()) }
    }, new CountQueuingStrategy({ highWaterMark: limits.outboundDatagramWindow }))

    // Fed by u.onRefusal (A87): a refused destination is ordinary P2P traffic, reported here rather than by rejecting `writable`'s sink -- credit-window reasoning: README.md's Design notes.
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
      // GETTERS, not values copied once -- README.md's Design notes.
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

  /** `fsOpen`'s counterpart to `buildSocket`/`buildUdpSocket` -- a plain request/reply round trip, no port or stream; each nested closure needs its own `callRevived` since any one can reject independently. */
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

  /** `buildFile`'s own web.openContext counterpart (ADR-0019) -- `closed` is already live by the time it crosses here (surface/web.ts's watchClose), so `pageClosed` is all it needs, same as `s.closed` in `buildSocket`. */
  function buildWebContext (w: Awaited<ReturnType<typeof bridge.webOpenContext>>): MainWorldWebContextBridge {
    return Object.freeze({
      id: w.id, origin: w.origin, closed: pageClosed(w.closed),
      evaluate: async (script: string, options?: { timeoutMs?: number }) => await callRevived(w.evaluate(script, options)),
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

  // Refuses extension code at every page-callable method below, over every built-in the decision path calls -- decision rule, what it catches and why: README.md's Design notes.
  const RealError = Error
  const nativeCaptureStackTrace = RealError.captureStackTrace
  const { defineProperty: defineOwn, getOwnPropertyDescriptor: ownDescriptor, apply: applyOwn, getPrototypeOf: getProtoOf } = Reflect
  const mapOwn = Array.prototype.map
  const someOwn = Array.prototype.some
  const { indexOf: indexOfOwn, startsWith: startsWithOwn } = String.prototype
  function hasSource (text: unknown, needles: readonly string[]): boolean {
    return typeof text === 'string' && applyOwn(someOwn, needles, [(needle: string) => applyOwn(indexOfOwn, text, [needle]) !== -1])
  }
  interface CallerFrame { fileName?: string, scriptNameOrSourceURL?: string, evalOrigin?: string }
  // A document that is itself a local file runs scripts it loaded from `file:`, as a web page does from http(s); a web document has no `file:` frame of its own to count.
  const fileDocument = typeof window !== 'undefined' && window.location.protocol === 'file:'
  /** Pure over already-captured frames (the wrapper's own already excluded). A verbatim top-level copy lives in tests/main-world-socket-extension-filter.test.ts -- one test there asserts the two never drift; this one cannot be imported (file header). */
  function callerIsRefused (frames: readonly CallerFrame[]): boolean {
    const isExtension = (f: CallerFrame): boolean =>
      hasSource(f.fileName, ['chrome-extension://']) || hasSource(f.scriptNameOrSourceURL, ['chrome-extension://']) || hasSource(f.evalOrigin, ['chrome-extension://'])
    // A real script's fileName only, STARTS-WITH -- never scriptNameOrSourceURL or an eval origin, both of which a `//# sourceURL=...` comment rewrites. README.md's Design notes.
    const startsWithAny = (text: unknown, prefixes: readonly string[]): boolean =>
      typeof text === 'string' && applyOwn(someOwn, prefixes, [(prefix: string) => applyOwn(startsWithOwn, text, [prefix])])
    const isPage = (f: CallerFrame): boolean => startsWithAny(f.fileName, ['http://', 'https://', 'blob:http://', 'blob:https://']) || (fileDocument && startsWithAny(f.fileName, ['file://']))
    if (applyOwn(someOwn, frames, [isExtension])) return true
    return !applyOwn(someOwn, frames, [isPage])
  }
  // The four CallSite.prototype methods, saved by mapFrames' own first call
  // (forced synchronously below); a live/saved mismatch is itself tamper. README.md's Design notes.
  let savedCallSiteMethods: CallSiteMethods | undefined
  function mapFrames (raw: readonly NodeJS.CallSite[]): CallerFrame[] {
    return applyOwn(mapOwn, raw, [(cs: NodeJS.CallSite) => {
      const live = getProtoOf(cs) as CallSiteMethods | null
      if (live === null) throw new RealError('orivon: no CallSite prototype')
      if (savedCallSiteMethods === undefined) {
        savedCallSiteMethods = { getFileName: live.getFileName, getScriptNameOrSourceURL: live.getScriptNameOrSourceURL, isEval: live.isEval, getEvalOrigin: live.getEvalOrigin }
      } else if (live.getFileName !== savedCallSiteMethods.getFileName || live.getScriptNameOrSourceURL !== savedCallSiteMethods.getScriptNameOrSourceURL ||
                 live.isEval !== savedCallSiteMethods.isEval || live.getEvalOrigin !== savedCallSiteMethods.getEvalOrigin) {
        throw new RealError('orivon: CallSite prototype tampered')
      }
      const m = savedCallSiteMethods
      if (m.getFileName === undefined || m.getScriptNameOrSourceURL === undefined || m.isEval === undefined || m.getEvalOrigin === undefined) throw new RealError('orivon: CallSite methods unavailable')
      return {
        fileName: applyOwn(m.getFileName, cs, []) ?? undefined,
        scriptNameOrSourceURL: applyOwn(m.getScriptNameOrSourceURL, cs, []) ?? undefined,
        evalOrigin: applyOwn(m.isEval, cs, []) ? applyOwn(m.getEvalOrigin, cs, []) : undefined
      }
    }]) as CallerFrame[]
  }
  /** Captures `exclude`'s caller's stack, excluding `exclude`'s own frame. `tampered: true` when the capture machinery was frozen first -- refuse rather than decide from an empty/partial stack. */
  function captureCaller (exclude: (...args: never[]) => unknown): { tampered: boolean, frames: CallerFrame[] } {
    const savedPrepare = ownDescriptor(RealError, 'prepareStackTrace')
    let setPrepare = false
    try { setPrepare = defineOwn(RealError, 'prepareStackTrace', { value: (_e: Error, s: unknown) => s, writable: true, configurable: true, enumerable: false }) } catch { setPrepare = false }
    if (!setPrepare) return { tampered: true, frames: [] }
    const savedLimit = ownDescriptor(RealError, 'stackTraceLimit')
    let setLimit = false
    try { setLimit = defineOwn(RealError, 'stackTraceLimit', { value: Infinity, writable: true, configurable: true, enumerable: false }) } catch { setLimit = false }
    // Any frozen value refuses raising it to Infinity, not just 0 -- README.md's Design notes.
    let tampered = !setLimit
    let frames: CallerFrame[] = []
    if (!tampered) {
      try {
        const holder: { stack?: unknown } = {}
        if (typeof nativeCaptureStackTrace === 'function') applyOwn(nativeCaptureStackTrace, RealError, [holder, exclude])
        else holder.stack = new RealError().stack
        const raw = holder.stack as NodeJS.CallSite[] | undefined
        frames = raw !== undefined && raw.length > 0 ? mapFrames(raw) : []
        if (frames.length === 0) tampered = true
      } catch { tampered = true }
    }
    try { if (savedPrepare !== undefined) defineOwn(RealError, 'prepareStackTrace', savedPrepare); else delete (RealError as { prepareStackTrace?: unknown }).prepareStackTrace } catch { /* best effort restore */ }
    try { if (setLimit) { if (savedLimit !== undefined) defineOwn(RealError, 'stackTraceLimit', savedLimit); else delete (RealError as { stackTraceLimit?: unknown }).stackTraceLimit } } catch { /* best effort restore */ }
    return { tampered, frames }
  }
  // Forces the bootstrap capture above to happen NOW, before any page or
  // extension script runs, rather than on whatever call is first; a failed
  // bootstrap leaves savedCallSiteMethods permanently mismatched (`{}`),
  // refusing every call. Genuinely CALLED, not just referenced --
  // captureStackTrace's exclude only trims a frame that is on the stack.
  function bootstrapCallSiteMethods (): void { captureCaller(bootstrapCallSiteMethods) }
  bootstrapCallSiteMethods()
  if (savedCallSiteMethods === undefined) savedCallSiteMethods = {}
  function refusal (): Error & { code: OrivonErrorCode } { return toOrivonError('denied', { message: "orivon: refused -- the caller could not be attributed to this page's own script" }) }
  /** Wraps one page-callable leaf: `sync` (`fs.readFileSync` alone) throws on refusal, matching its own never-a-Promise shape; every other method rejects. Internal callers reach `fn` directly (`netConnectImpl` below), never through `wrapped`. */
  function guarded<F extends (...args: never[]) => unknown> (fn: F, sync = false): F {
    if (!attributeCallers) return fn
    function wrapped (...args: unknown[]): unknown {
      const captured = captureCaller(wrapped)
      if (captured.tampered || callerIsRefused(captured.frames)) {
        if (sync) throw refusal()
        return Promise.reject(refusal())
      }
      return applyOwn(fn, undefined, args)
    }
    return wrapped as unknown as F
  }

  // UNWRAPPED net.connect/net.connectSecure -- ../routed/dial.ts's own use, via the internal-net slot below (README.md's Design notes).
  const netConnectImpl = async (opts: { host: string, port: number }): Promise<unknown> => buildSocket(await callRevived(bridge.netConnect(opts)))
  const netConnectSecureImpl = async (opts: SecureConnectOptions): Promise<unknown> => buildSocket(await callRevived(bridge.netConnectSecure(opts)))

  /** One blocking round trip over `bridge.fsSync`. It never throws, so the failure is built and thrown HERE, never via callRevived. */
  function syncCall (op: string, args: unknown[]): unknown {
    const r = bridge.fsSync(op, args)
    if (r.ok) return r.result
    throw toOrivonError(r.code, r.platformCode === undefined ? { message: r.message } : { message: r.message, platformCode: r.platformCode })
  }
  // The page's synchronous twin of `fs` (`Symbol.for('orivon.synchronous')`, like a Worker's): the path-based members only, no `open`, attributed like readFileSync.
  const synchronousFs: Record<string, unknown> = {}
  for (const op of ['stat', 'readFile', 'writeFile', 'mkdir', 'readdir', 'rm', 'rename']) synchronousFs[op] = guarded((...args: unknown[]) => syncCall(op, args), true)

  const api = {
    version: 0,
    app: Object.freeze({
      manifest: guarded(async () => await callRevived(bridge.appManifest())),
      grants: guarded(async () => await callRevived(bridge.appGrants())),
      requestGrant: guarded(async (request: CapabilityRequest) => await callRevived(bridge.appRequestGrant(request)))
    }),
    fs: Object.freeze({
      readFile: guarded(async (path: string) => await callRevived(bridge.fsReadFile(path))),
      writeFile: guarded(async (path: string, data: Uint8Array) => { await callRevived(bridge.fsWriteFile(path, data)) }),
      // NOT `async`, genuinely synchronous through `executeInMainWorld` -- see `syncCall`.
      readFileSync: guarded((path: string) => syncCall('readFile', [path]) as Uint8Array, true),
      mkdir: guarded(async (path: string, opts?: { recursive?: boolean }) => { await callRevived(bridge.fsMkdir(path, opts)) }),
      readdir: guarded(async (path: string) => await callRevived(bridge.fsReaddir(path))),
      stat: guarded(async (path: string) => await callRevived(bridge.fsStat(path))),
      rm: guarded(async (path: string, opts?: { recursive?: boolean }) => { await callRevived(bridge.fsRm(path, opts)) }),
      rename: guarded(async (from: string, to: string) => { await callRevived(bridge.fsRename(from, to)) }),
      open: guarded(async (path: string, flags: string) => buildFile(await callRevived(bridge.fsOpen(path, flags)))),
      // Routes on `opts?.directory`, matching capability-api.ts's own overload split (A195).
      userSelected: guarded(async (opts?: { directory?: boolean, multiple?: boolean }) => {
        if (opts?.directory === true) {
          const dir = await callRevived(bridge.fsUserSelectedDirectory())
          return dir === null ? null : buildDirectory(dir)
        }
        const fileOpts = opts?.multiple === undefined ? undefined : { multiple: opts.multiple }
        return (await callRevived(bridge.fsUserSelected(fileOpts))).map(buildFile)
      })
    }),
    id: Object.freeze({
      publicKey: guarded(async (opts: { curve: string }) => await callRevived(bridge.idPublicKey(opts.curve))),
      sign: guarded(async (opts: { curve: string, payload: Uint8Array }) => await callRevived(bridge.idSign(opts.curve, opts.payload)))
    }),
    secrets: Object.freeze({
      available: guarded(async () => await callRevived(bridge.secretsAvailable())),
      encrypt: guarded(async (plaintext: Uint8Array) => await callRevived(bridge.secretsEncrypt(plaintext))),
      decrypt: guarded(async (ciphertext: Uint8Array) => await callRevived(bridge.secretsDecrypt(ciphertext)))
    }),
    trust: Object.freeze({
      websiteScore: guarded(async (address: string) => await callRevived(bridge.trustWebsiteScore(address)))
    }),
    web: Object.freeze({
      openContext: guarded(async (origin: string, options?: { width?: number, height?: number }) => buildWebContext(await callRevived(bridge.webOpenContext({ origin, ...options })))),
      setEmbedScript: guarded(async (source: string) => { await callRevived(bridge.webSetEmbedScript(source)) })
    }),
    net: Object.freeze({
      connect: guarded(netConnectImpl),
      connectSecure: guarded(netConnectSecureImpl),
      udpBind: guarded(async (opts: { port: number, scope?: BindScope }) => buildUdpSocket(await callRevived(bridge.netUdpBind(opts)))),
      listen: guarded(async (opts: { port: number, scope?: BindScope }) => buildServer(await callRevived(bridge.netListen(opts)))),
      lookup: guarded(async (opts: { hostname: string }) => await callRevived(bridge.netLookup(opts)))
    })
  }
  // Not on the child host's object: it never meets a page, so there is no call to attribute.
  if (attributeCallers) Object.defineProperty(api, Symbol.for('orivon.synchronous'), { value: Object.freeze({ fs: Object.freeze(synchronousFs) }) })
  // A plain assignment would let a page script replace orivon.net.connect for every other script on the same page.
  Object.defineProperty(target, 'orivon', { value: Object.freeze(api), writable: false, configurable: false, enumerable: true })

  // A private slot for the ../routed/ installers alone -- README.md's Design notes. `callerIsPage` is `guarded`'s own attribution, shared rather than copied a third time.
  try {
    Reflect.defineProperty(target, Symbol.for('orivon.internal-net'), {
      value: Object.freeze({
        connect: netConnectImpl, connectSecure: netConnectSecureImpl,
        callerIsPage: (exclude: (...args: never[]) => unknown) => { const c = captureCaller(exclude); return !c.tampered && !callerIsRefused(c.frames) }
      }),
      writable: false, configurable: true, enumerable: false
    })
  } catch { /* no internal net path for ../routed/ this session; it fails closed on its own missing-slot check */ }
}
