import { contextBridge, ipcRenderer } from 'electron'
import { CONTROL_CHANNEL } from '../main/channels.js'
import type { Grant, Manifest, OrivonErrorCode } from '../contracts/index.js'
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
// on the other side of CONTROL_CHANNEL. Four methods are wired: app.
// manifest, app.grants, fs.readFile, fs.writeFile. net.connect is
// DELIBERATELY absent here even though the broker implements it: a
// TcpSocket's real shape is readable/writable/close/closed
// (contracts/capability-api.ts), and nothing on this control channel carries
// a live handle across IPC yet -- that is the per-socket byte-pump task's
// job (MessageChannelMain, the credit window, contracts/ipc.ts's
// DataMessage/CreditMessage). Wiring net.connect here first would mean
// returning a socket descriptor with no way to ever close it, leaking one
// handle-table slot and one fd per call. Everything else in
// docs/architecture/capability-api.md (net.connect until the byte pump
// lands, net.listen, udpBind, fs.open/mkdir/readdir/stat/rm/rename/
// userSelected, id.*, app.requestGrant) is simply absent from the object
// below -- the broker does not implement the rest yet either, and a method
// that always threw 'invalid' would be worse than a method that is not
// there.
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
  fs: 15_000
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

/** Exposes `window.orivon` in the calling preload's main world. Idempotent
 * per-world, but never called twice from the same script -- each caller
 * (app.ts, newtab.ts's fallback branch) calls it exactly once. */
export function exposeOrivon (): void {
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
}
