import { contextBridge, ipcRenderer } from 'electron'
import { CONTROL_CHANNEL } from '../main/channels.js'
import type { Grant, Manifest, OrivonErrorCode } from '../contracts/index.js'
import type { RequestEnvelope, ResponseEnvelope } from '../contracts/ipc.js'

// Loaded by every ORDINARY TAB (src/main/tabs.ts) -- unprivileged. The
// chrome view (tab strip + toolbar) loads preload/shell.ts instead, which
// is privileged and must never be reachable from here.
//
// Build step 2's control surface -- ../broker/ipc.ts's handleControlRequest,
// on the other side of CONTROL_CHANNEL. Five methods are wired: app.
// manifest, app.grants, net.connect, fs.readFile, fs.writeFile. Everything
// else in docs/architecture/capability-api.md (net.listen, udpBind, fs.open/
// mkdir/readdir/stat/rm/rename/userSelected, id.*, app.requestGrant) is
// simply absent from the object below -- the broker does not implement them
// yet either, and a method that always threw 'invalid' would be worse than
// a method that is not there.
//
// Importing CONTROL_CHANNEL from ../main/channels.js, not ../broker/, is
// deliberate and matches preload/shell.ts's own precedent (COMMAND_CHANNEL/
// STATE_CHANNEL, same file): this README's "never import src/broker/" rule
// is about broker LOGIC, which cannot run in a renderer process at all --
// channels.ts is a zero-dependency leaf of plain string constants, safe in
// either process, and the one neutral place a channel name shared across
// this trust boundary can live.
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
  /** net.connect: a real TCP handshake, which can legitimately be slow. */
  net: 30_000,
  /** fs.readFile / fs.writeFile: disk I/O, generous for a large file. */
  fs: 15_000
} as const

interface OrivonErrorLike extends Error {
  readonly code: OrivonErrorCode
  readonly platformCode?: string
}

function toOrivonError (code: OrivonErrorCode, message: string, platformCode?: string): OrivonErrorLike {
  const error = new Error(message) as OrivonErrorLike & { code: OrivonErrorCode, platformCode?: string }
  error.name = 'OrivonError'
  error.code = code
  if (platformCode !== undefined) error.platformCode = platformCode
  return error
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

async function call<TResult> (method: string, payload: unknown, timeoutMs: number): Promise<TResult> {
  const envelope: RequestEnvelope<unknown> = { id: crypto.randomUUID(), method, payload, timeoutMs }
  const response = await raceTimeout(
    ipcRenderer.invoke(CONTROL_CHANNEL, envelope) as Promise<ResponseEnvelope<TResult>>,
    timeoutMs
  )
  if (response.ok) return response.result
  throw toOrivonError(response.code, response.message, response.platformCode)
}

contextBridge.exposeInMainWorld('orivon', {
  version: 0,
  app: {
    manifest: async (): Promise<Manifest> => await call('app.manifest', undefined, TIMEOUT_MS.metadata),
    grants: async (): Promise<readonly Grant[]> => await call('app.grants', undefined, TIMEOUT_MS.metadata)
  },
  net: {
    connect: async (opts: { host: string, port: number }) => await call('net.connect', opts, TIMEOUT_MS.net)
  },
  fs: {
    readFile: async (path: string): Promise<Uint8Array> => await call('fs.readFile', { path }, TIMEOUT_MS.fs),
    writeFile: async (path: string, data: Uint8Array): Promise<void> =>
      await call('fs.writeFile', { path, data }, TIMEOUT_MS.fs)
  }
})
