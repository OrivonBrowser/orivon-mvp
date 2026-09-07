import { contextBridge, ipcRenderer } from 'electron'
import { CONTROL_CHANNEL, PORT_CHANNEL } from '../main/channels.js'
import { createSocketBridge } from './socket-bridge.js'
import type { IpcRendererLike } from './socket-bridge.js'
import { createSocketPort } from './socket-port.js'
import { createDatagramPort } from './datagram-port.js'
import type { PortLike } from './socket-port.js'
import { installOrivon } from './main-world-socket.js'
import type { MainWorldSocketBridge, MainWorldUdpBridge } from './main-world-socket.js'
import type { Grant, Manifest, OrivonErrorCode } from '../contracts/index.js'
import { LIMITS } from '../contracts/index.js'
import type { RequestEnvelope, ResponseEnvelope } from '../contracts/ipc.js'
import { toOrivonError } from './orivon-error.js'

// The real orivon.* surface, shared by preload/app.ts and preload/newtab.ts's
// fallback branch. See README.md SSDesign notes for why this file is shaped
// the way it is (the two-world split, the CONTROL_CHANNEL import source,
// what is and isn't wired yet).
//
// Nothing below hands the page anything but a Promise-returning closure --
// `call()` is the only thing that ever touches `ipcRenderer` (the raw
// MessagePortMain/ipcRenderer never crossing into the main world is this
// whole directory's rule, not just this file's). Every call carries an
// explicit timeout (../contracts/ipc.ts's rule 2) -- see each budget below.
const TIMEOUT_MS = {
  /** app.manifest / app.grants: broker-local reads, no I/O of their own. */
  metadata: 5_000,
  /** fs.readFile / fs.writeFile: disk I/O, generous for a large file. */
  fs: 15_000,
  /**
   * net.connect / net.close / net.setNoDelay / net.setKeepAlive. Must
   * exceed node-adapters.ts's own DIAL_TIMEOUT_MS (30_000) -- otherwise a
   * legitimately slow dial reports THIS timeout instead of the broker's
   * real 'timeout' answer, discarding the more specific error for a less
   * useful one.
   */
  net: 35_000
} as const

/**
 * Settles with a synthetic failure ResponseEnvelope -- 'timeout' if `promise`
 * has not settled within `timeoutMs`, 'internal' if it rejects outright --
 * rather than ever rejecting itself. That gives `call()` below exactly one
 * place that turns a failure envelope into a thrown OrivonError, regardless
 * of which of the three ways (broker failure response, our own timeout, a
 * raw rejection) the underlying call failed. A raw rejection is possible
 * here (Electron's own internal string, a serialisation refusal) and must
 * never reach the page unwrapped -- contracts/errors.ts requires every
 * rejection an app sees to be OrivonError-shaped so an exhaustive
 * `switch (e.code)` works.
 */
async function raceTimeout<T> (promise: Promise<ResponseEnvelope<T>>, timeoutMs: number): Promise<ResponseEnvelope<T>> {
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ id: '', ok: false, code: 'timeout', message: `control call exceeded its ${timeoutMs}ms budget` })
    }, timeoutMs)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => {
        clearTimeout(timer)
        // The isolated world's OWN console -- contextIsolation means the
        // page cannot see or intercept this call. See ./README.md's design
        // notes for why the underlying error can never just be re-thrown.
        console.error('[orivon] control call failed', error)
        resolve({ id: '', ok: false, code: 'internal', message: 'control call failed' })
      }
    )
  })
}

// A plain counter, not crypto.randomUUID(): the id only has to correlate a
// reply within this process's own ipcRenderer.invoke() call (which already
// does that matching itself), never anything security-relevant -- and
// randomUUID() is gated to secure contexts, which a plain http:// origin on
// a non-loopback host is not (ORIGIN_BEARING_SCHEMES, ../broker/policy/
// origin.js, includes http:). That would turn every control call into a
// thrown TypeError instead of an OrivonError, on a path smoke's loopback
// fixtures cannot reach.
let nextRequestId = 0

async function call<TResult> (method: string, payload: unknown, timeoutMs: number): Promise<TResult> {
  const envelope: RequestEnvelope<unknown> = { id: `r${++nextRequestId}`, method, payload, timeoutMs }
  const response = await raceTimeout(
    ipcRenderer.invoke(CONTROL_CHANNEL, envelope) as Promise<ResponseEnvelope<TResult>>,
    timeoutMs
  )
  if (response.ok) return response.result
  throw toOrivonError(response.code, response.platformCode === undefined
    ? { message: response.message }
    : { message: response.message, platformCode: response.platformCode })
}

/**
 * What `net.connect`'s CONTROL_CHANNEL reply actually carries -- deliberately
 * NOT imported from ../broker/transport/port-transport.ts's SocketDescriptor: this
 * directory's own README forbids importing src/broker/ at all (a preload
 * runs in the renderer process; broker logic cannot run there), so the
 * shape is repeated at this trust boundary rather than shared across it.
 */
interface SocketDescriptor {
  readonly id: string
  readonly remoteAddress: string
  readonly remotePort: number
  readonly localAddress: string
  readonly localPort: number
}

/** `net.udpBind`'s reply. Repeated at this trust boundary for the same reason SocketDescriptor is. */
interface UdpSocketDescriptor {
  readonly id: string
  readonly localAddress: string
  readonly localPort: number
}

/** Adapts a real (DOM) `MessagePort` -- Electron's own conversion of the transferred `MessagePortMain` -- to ./socket-port.ts's PortLike. */
function wrapPort (raw: unknown): PortLike {
  const port = raw as MessagePort
  return {
    postMessage: (message) => { port.postMessage(message) },
    // Assigning .onmessage (rather than addEventListener) implicitly starts
    // the port per the WHATWG spec -- no separate port.start() needed.
    onMessage: (listener) => { port.onmessage = (event) => { listener(event.data) } },
    close: () => { port.close() }
  }
}

const socketBridge = createSocketBridge({ ipcRenderer: ipcRenderer as unknown as IpcRendererLike, portChannel: PORT_CHANNEL, wrapPort })

/**
 * The one net.connect closure handed into the main world. Correlates the
 * CONTROL_CHANNEL descriptor with its separately-delivered PORT_CHANNEL
 * port (socketBridge.waitForPort handles either arrival order), then wraps
 * that port in a SocketPort (./socket-port.ts) -- the whole per-socket state
 * machine main-world-socket.ts needs, plus the three control-channel
 * operations (close/setNoDelay/setKeepAlive) net.connect itself doesn't
 * expose.
 */
async function netConnectBridge (opts: { host: string, port: number }): Promise<MainWorldSocketBridge> {
  const descriptor = await call<SocketDescriptor>('net.connect', opts, TIMEOUT_MS.net)
  try {
    return buildBridgeResult(descriptor, await socketBridge.waitForPort(descriptor.id))
  } catch (error) {
    // The broker already registered this socket against the concurrentSockets
    // cap the instant net.connect replied -- if anything after that fails
    // (most plausibly waitForPort's own 35s timeout racing a slow-but-real
    // dial), nothing else on this side ever tells it to release the slot.
    // Best-effort and fire-and-forget: this cleanup's own failure must not
    // shadow the real error the caller is about to see.
    call('net.close', { id: descriptor.id }, TIMEOUT_MS.net).catch(() => {})
    throw error
  }
}

function buildBridgeResult (descriptor: SocketDescriptor, port: PortLike): MainWorldSocketBridge {
  const socketPort = createSocketPort({ handleId: descriptor.id, port })

  return {
    id: descriptor.id,
    remoteAddress: descriptor.remoteAddress,
    remotePort: descriptor.remotePort,
    localAddress: descriptor.localAddress,
    localPort: descriptor.localPort,
    onData: socketPort.onData,
    onReadEnd: socketPort.onReadEnd,
    reportConsumed: socketPort.reportConsumed,
    write: socketPort.write,
    endWrite: socketPort.endWrite,
    abortWrite: socketPort.abortWrite,
    onFatal: socketPort.onFatal,
    closed: socketPort.closed,
    close: async () => {
      await call('net.close', { id: descriptor.id }, TIMEOUT_MS.net)
      socketPort.dispose()
    },
    setNoDelay: async (on) => { await call('net.setNoDelay', { id: descriptor.id, on }, TIMEOUT_MS.net) },
    setKeepAlive: async (on, initialDelayMs) => {
      // exactOptionalPropertyTypes: an explicit `initialDelayMs: undefined`
      // is not the same as omitting the key.
      const payload = initialDelayMs === undefined
        ? { id: descriptor.id, on }
        : { id: descriptor.id, on, initialDelayMs }
      await call('net.setKeepAlive', payload, TIMEOUT_MS.net)
    }
  }
}

/**
 * `net.udpBind`'s counterpart to netConnectBridge, and it correlates the same
 * two channels the same way -- ./socket-bridge.ts is kind-agnostic, so the
 * caller is what knows which kind of port it asked for.
 */
async function netUdpBindBridge (opts: { port: number }): Promise<MainWorldUdpBridge> {
  const descriptor = await call<UdpSocketDescriptor>('net.udpBind', opts, TIMEOUT_MS.net)
  try {
    return buildUdpBridgeResult(descriptor, await socketBridge.waitForPort(descriptor.id))
  } catch (error) {
    // Same reasoning as netConnectBridge's: the broker counted this socket
    // against concurrentSockets the instant it replied, and nothing else on
    // this side would ever release the slot.
    call('net.close', { id: descriptor.id }, TIMEOUT_MS.net).catch(() => {})
    throw error
  }
}

function buildUdpBridgeResult (descriptor: UdpSocketDescriptor, port: PortLike): MainWorldUdpBridge {
  const datagramPort = createDatagramPort({ handleId: descriptor.id, port })

  return {
    id: descriptor.id,
    localAddress: descriptor.localAddress,
    localPort: descriptor.localPort,
    onDatagram: datagramPort.onDatagram,
    onReadEnd: datagramPort.onReadEnd,
    onDropped: datagramPort.onDropped,
    onFatal: datagramPort.onFatal,
    reportConsumed: datagramPort.reportConsumed,
    send: datagramPort.send,
    closed: datagramPort.closed,
    close: async () => {
      await call('net.close', { id: descriptor.id }, TIMEOUT_MS.net)
      datagramPort.dispose()
    }
  }
}

// The four closures both exposeFallback (no net) and the executeInMainWorld
// bridge (with net) need -- one implementation, reused by both, rather than
// two copies of the same broker call/timeout pair (code-guidelines.md Rule
// 3, the same reuse fix-80's B-F11 applied to installFromHint).
async function appManifest (): Promise<Manifest> { return await call('app.manifest', undefined, TIMEOUT_MS.metadata) }
async function appGrants (): Promise<readonly Grant[]> { return await call('app.grants', undefined, TIMEOUT_MS.metadata) }
async function fsReadFile (path: string): Promise<Uint8Array> { return await call('fs.readFile', { path }, TIMEOUT_MS.fs) }
async function fsWriteFile (path: string, data: Uint8Array): Promise<void> {
  await call('fs.writeFile', { path, data }, TIMEOUT_MS.fs)
}

/** The `net`-less surface: used both when `executeInMainWorld` is absent and when it exists but throws (P-F10) -- one implementation, not two copies quietly drifting apart. */
function exposeFallback (): void {
  contextBridge.exposeInMainWorld('orivon', {
    version: 0,
    app: { manifest: appManifest, grants: appGrants },
    fs: { readFile: fsReadFile, writeFile: fsWriteFile }
  })
}

/**
 * Exposes `window.orivon` in the calling preload's main world. Idempotent
 * per-world, but never called twice from the same script -- each caller
 * (app.ts, newtab.ts's fallback branch) calls it exactly once.
 *
 * FAIL-CLOSED: `contextBridge.executeInMainWorld` is `@experimental`
 * (electron.d.ts) -- confirmed working live (a throwaway probe: a
 * sandboxed preload, a function argument proxied and callable from the
 * main world, a callback passed back through it, a real main-world
 * ReadableStream built this way behaving normally for page code), but if
 * it is ever unavailable, OR THROWS (a serialisation refusal, a CSP issue,
 * an `@experimental` API not actually ready), this falls back to
 * `exposeFallback()` WITHOUT `net` rather than ship a `net.connect` whose
 * return value is not a real `TcpSocket` -- the exact failure mode
 * ADR-0002 exists to prevent for this interface -- or, worse, abort the
 * whole preload script and leave the page with no `window.orivon` at all.
 */
export function exposeOrivon (): void {
  if (typeof contextBridge.executeInMainWorld !== 'function') {
    exposeFallback()
    return
  }

  const bridge = {
    appManifest,
    appGrants,
    fsReadFile,
    fsWriteFile,
    netConnect: netConnectBridge,
    netUdpBind: netUdpBindBridge
  }
  try {
    contextBridge.executeInMainWorld({
      func: installOrivon,
      args: [bridge, {
        readWindowBytes: LIMITS.readWindowBytes,
        writeWindowBytes: LIMITS.writeWindowBytes,
        inboundDatagramWindow: LIMITS.inboundDatagramWindow,
        outboundDatagramWindow: LIMITS.outboundDatagramWindow
      }]
    })
  } catch (error) {
    console.error('[orivon] executeInMainWorld failed; falling back without net', error)
    exposeFallback()
  }
}
