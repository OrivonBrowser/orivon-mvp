import { contextBridge, ipcRenderer } from 'electron'
import { CONTROL_CHANNEL, PORT_CHANNEL } from '../main/channels.js'
import { createSocketBridge } from './socket-bridge.js'
import type { IpcRendererLike } from './socket-bridge.js'
import { createSocketPort } from './socket-port.js'
import type { PortLike } from './socket-port.js'
import { installOrivon } from './main-world-socket.js'
import type { MainWorldSocketBridge } from './main-world-socket.js'
import type { Grant, Manifest, OrivonErrorCode } from '../contracts/index.js'
import { LIMITS } from '../contracts/index.js'
import type { RequestEnvelope, ResponseEnvelope } from '../contracts/ipc.js'

// The real orivon.* surface, shared by BOTH places it is exposed: every
// ordinary tab (preload/app.ts) and a dashboard tab the user has navigated
// away from (preload/newtab.ts's fallback branch -- its own comment already
// promised "the same { version: 0 } every ordinary tab already gets from
// preload/app.ts", which this file is what makes literally true rather than
// two copies of the same object maintained separately, code-guidelines.md
// Rule 3).
//
// Build step 2's control surface -- ../broker/ipc.ts's handleControlRequest,
// on the other side of CONTROL_CHANNEL. Six methods are wired: app.
// manifest, app.grants, fs.readFile, fs.writeFile, net.connect, net.close
// (plus net.setNoDelay/setKeepAlive). Everything else in
// docs/architecture/capability-api.md (net.listen, udpBind, fs.open/mkdir/
// readdir/stat/rm/rename/userSelected, id.*, app.requestGrant) is simply
// absent from the object below -- the broker does not implement the rest
// yet either, and a method that always threw 'invalid' would be worse than
// a method that is not there.
//
// NET.CONNECT'S REAL SHAPE (readable/writable are actual WHATWG streams,
// contracts/capability-api.ts) CANNOT BE BUILT HERE, in the isolated world.
// contextBridge copies plain values into the main world; it does not proxy
// a stream built on this side intact (checked live via context7 against
// Electron's own docs: "Function values are proxied, while other data
// types are copied and frozen" -- a copied ReadableStream loses its
// prototype). ./main-world-socket.ts's installOrivon is therefore handed to
// contextBridge.executeInMainWorld below: it runs IN the main world, so its
// own `ReadableStream`/`WritableStream` are the page's real constructors,
// wired to plain proxied closures (`netConnectBridge` below) built here.
//
// Importing CONTROL_CHANNEL from ../main/channels.js, not ../broker/, is
// deliberate and matches preload/shell.ts's own precedent (COMMAND_CHANNEL/
// STATE_CHANNEL, same file): this directory's own README's "never import
// src/broker/" rule is about broker LOGIC, which cannot run in a renderer
// process at all -- channels.ts is a zero-dependency leaf of plain string
// constants, safe in either process, and the one neutral place a channel
// name shared across this trust boundary can live.
//
// THE RULE THIS FILE IS HELD TO (this directory's own README): the raw
// MessagePortMain -- and here, the raw ipcRenderer -- never crosses into the
// main world. Nothing below hands the page anything but a Promise-returning
// closure; `call()` is the only thing that ever touches `ipcRenderer`.
//
// EVERY CALL CARRIES AN EXPLICIT TIMEOUT (../contracts/ipc.ts's rule 2,
// ../broker/ipc.ts's own withTimeout does the same on the main side). The
// literal budgets below are this file's own choice -- capability-api.md
// does not specify one -- flagged as an AI recommendation in the PR body.
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

// A PLAIN OBJECT, never `new Error(...)` -- confirmed empirically via a real
// Electron launch (scripts/smoke.mjs), not assumed: contextBridge's promise-
// rejection marshaling only preserves `.message` on a value that IS an
// `Error` instance, silently discarding every custom property (`.code`,
// `.platformCode`) and even overwriting `.name` back to the generic
// `'Error'`. A value that is NOT `instanceof Error` crosses the same bridge
// through the ordinary structured-clone path instead -- the one that
// already carries `SocketDescriptor`-shaped results and plain arrays
// (`orivon.app.grants()`'s `[]`) over intact. contracts/errors.ts's own
// header explains why this is contract-legal, not a workaround: OrivonError
// is declared as an interface, deliberately not a class, precisely because
// "every consumer only needs its shape" -- and TypeScript's structural
// `Error` (name, message, stack?) does not require `instanceof Error` at
// runtime, only these fields.
interface OrivonErrorLike {
  readonly name: string
  readonly message: string
  readonly code: OrivonErrorCode
  readonly platformCode?: string
}

function toOrivonError (code: OrivonErrorCode, message: string, platformCode?: string): OrivonErrorLike {
  return platformCode === undefined
    ? { name: 'OrivonError', message, code }
    : { name: 'OrivonError', message, code, platformCode }
}

/**
 * Settles with a synthetic 'timeout' ResponseEnvelope if `promise` has not
 * settled within `timeoutMs`, rather than rejecting directly -- so `call()`
 * below has exactly one place that turns a failure envelope into a thrown
 * OrivonError, whether the failure came from the broker or from this guard.
 */
async function raceTimeout<T> (promise: Promise<ResponseEnvelope<T>>, timeoutMs: number): Promise<ResponseEnvelope<T>> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve({ id: '', ok: false, code: 'timeout', message: `control call exceeded its ${timeoutMs}ms budget` })
    }, timeoutMs)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) }
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
  throw toOrivonError(response.code, response.message, response.platformCode)
}

/**
 * What `net.connect`'s CONTROL_CHANNEL reply actually carries -- deliberately
 * NOT imported from ../broker/port-transport.ts's SocketDescriptor: this
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
  const port = await socketBridge.waitForPort(descriptor.id)
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
 * Exposes `window.orivon` in the calling preload's main world. Idempotent
 * per-world, but never called twice from the same script -- each caller
 * (app.ts, newtab.ts's fallback branch) calls it exactly once.
 *
 * FAIL-CLOSED: `contextBridge.executeInMainWorld` is `@experimental`
 * (electron.d.ts) -- confirmed working live (a throwaway probe: a
 * sandboxed preload, a function argument proxied and callable from the
 * main world, a callback passed back through it, a real main-world
 * ReadableStream built this way behaving normally for page code), but if
 * it is ever unavailable this falls back to today's `exposeInMainWorld`
 * WITHOUT `net` rather than ship a `net.connect` whose return value is not
 * a real `TcpSocket` -- the exact failure mode ADR-0002 exists to prevent
 * for this interface.
 */
export function exposeOrivon (): void {
  if (typeof contextBridge.executeInMainWorld !== 'function') {
    contextBridge.exposeInMainWorld('orivon', {
      version: 0,
      app: {
        manifest: async (): Promise<Manifest> => await call('app.manifest', undefined, TIMEOUT_MS.metadata),
        grants: async (): Promise<readonly Grant[]> => await call('app.grants', undefined, TIMEOUT_MS.metadata)
      },
      fs: {
        readFile: async (path: string): Promise<Uint8Array> => await call('fs.readFile', { path }, TIMEOUT_MS.fs),
        writeFile: async (path: string, data: Uint8Array): Promise<void> =>
          await call('fs.writeFile', { path, data }, TIMEOUT_MS.fs)
      }
    })
    return
  }

  const bridge = {
    appManifest: async (): Promise<Manifest> => await call('app.manifest', undefined, TIMEOUT_MS.metadata),
    appGrants: async (): Promise<readonly Grant[]> => await call('app.grants', undefined, TIMEOUT_MS.metadata),
    fsReadFile: async (path: string): Promise<Uint8Array> => await call('fs.readFile', { path }, TIMEOUT_MS.fs),
    fsWriteFile: async (path: string, data: Uint8Array): Promise<void> =>
      await call('fs.writeFile', { path, data }, TIMEOUT_MS.fs),
    netConnect: netConnectBridge
  }
  contextBridge.executeInMainWorld({
    func: installOrivon,
    args: [bridge, { readWindowBytes: LIMITS.readWindowBytes, writeWindowBytes: LIMITS.writeWindowBytes }]
  })
}
