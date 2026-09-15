import { contextBridge, ipcRenderer } from 'electron'
import { SYNC_CONTROL_CHANNEL } from '../main/channels.js'
import { installOrivon } from './main-world-socket.js'
import type { CapabilityRequest, FileStat, Grant, Manifest } from '../contracts/index.js'
import { LIMITS } from '../contracts/index.js'
import type { ResponseEnvelope } from '../contracts/ipc.js'
import { toOrivonError } from './orivon-error.js'
import { TIMEOUT_MS, call } from './orivon-call.js'
import { netConnectBridge, netConnectSecureBridge, netListenBridge, netUdpBindBridge } from './orivon-net-bridge.js'

// The real orivon.* surface, shared by preload/app.ts and preload/newtab.ts's
// fallback branch. See README.md's Design notes section for why this file
// is shaped the way it is (the two-world split, the CONTROL_CHANNEL import
// source, what is and isn't wired yet).
//
// Nothing below hands the page anything but a Promise-returning closure,
// with ONE exception -- ADR-0016's deliberately narrow synchronous call,
// still never touching `ipcRenderer` directly from the page (it stays a
// plain proxied closure, exactly like every other method here). It is
// SPLIT INTO TWO FUNCTIONS, `fsReadFileSyncEnvelope`/`fsReadFileSyncThrowing`
// -- see their own docs -- because a THROWN value does not survive
// `contextBridge`'s function-proxy boundary intact (found live, not in a
// unit test); a RETURNED one does, so the envelope crosses as data and the
// real `OrivonError` is thrown on whichever side of the boundary the call
// already ends up on.
//
// `call()`/`TIMEOUT_MS` (./orivon-call.ts) and the four net.* bridge closures
// (./orivon-net-bridge.ts) moved out of this file under code-guidelines.md
// Rule 2, once net.listen's own addition pushed it past 500 lines -- by
// concern, not by line count: "the control-channel call primitive" and "how
// net crosses the isolated-world/main-world boundary" are both genuinely
// separate questions from "which app/fs/id closures exist and how they are
// exposed", which is what remains here.

// The six closures both exposeFallback (no net) and the executeInMainWorld
// bridge (with net) need -- one implementation, reused by both, rather than
// two copies of the same broker call/timeout pair (code-guidelines.md Rule
// 3). id.publicKey/sign need no main-world stream wrapping (net.connect's
// own reason for the executeInMainWorld dance) -- a plain Uint8Array in,
// Uint8Array out, exactly fs.readFile/writeFile's shape -- so they are wired
// identically to those two, not to net. The synchronous call just below is
// wired into both exposure sites too, but as TWO functions, not one --
// see fsReadFileSyncEnvelope's own doc for why -- because it is the one
// call() cannot serve: call() always returns a Promise (../../contracts/
// ipc.ts's rule 2, a required timeout on every reply) and this one, by
// design, never does.
async function appManifest (): Promise<Manifest> { return await call('app.manifest', undefined, TIMEOUT_MS.metadata) }
async function appGrants (): Promise<readonly Grant[]> { return await call('app.grants', undefined, TIMEOUT_MS.metadata) }
/**
 * `request.patterns` is flattened the same way `setKeepAlive`'s
 * `initialDelayMs` is: `exactOptionalPropertyTypes` treats an explicit
 * `patterns: undefined` as different from the key being absent, and only
 * the absent form means "whatever the manifest already declares"
 * (request-grant.ts's own contract) once it reaches the broker.
 */
async function appRequestGrant (request: CapabilityRequest): Promise<boolean> {
  const payload = request.patterns === undefined
    ? { capability: request.capability }
    : { capability: request.capability, patterns: request.patterns }
  return await call('app.requestGrant', payload, TIMEOUT_MS.grant)
}
async function fsReadFile (path: string): Promise<Uint8Array> { return await call('fs.readFile', { path }, TIMEOUT_MS.fs) }
async function fsWriteFile (path: string, data: Uint8Array): Promise<void> {
  await call('fs.writeFile', { path, data }, TIMEOUT_MS.fs)
}

// The extended fs surface (queue item 2.1). No main-world stream wrapping
// needed -- exactly fs.readFile/writeFile's own reasoning above -- so these
// four are wired the same way, reaching `call()` directly rather than
// through the executeInMainWorld dance net.connect needs.
//
// `opts?.recursive` is flattened to a bare `recursive` field (never an
// object holding it) on the wire: `exactOptionalPropertyTypes` treats an
// explicit `recursive: undefined` as different from omitting the key
// entirely, exactly like `setKeepAlive`'s `initialDelayMs` above -- so the
// key is included only when the caller actually passed one.
async function fsMkdir (path: string, opts?: { recursive?: boolean }): Promise<void> {
  const payload = opts?.recursive === undefined ? { path } : { path, recursive: opts.recursive }
  await call('fs.mkdir', payload, TIMEOUT_MS.fs)
}
async function fsReaddir (path: string): Promise<readonly string[]> { return await call('fs.readdir', { path }, TIMEOUT_MS.fs) }
async function fsStat (path: string): Promise<FileStat> { return await call('fs.stat', { path }, TIMEOUT_MS.fs) }
async function fsRm (path: string, opts?: { recursive?: boolean }): Promise<void> {
  const payload = opts?.recursive === undefined ? { path } : { path, recursive: opts.recursive }
  await call('fs.rm', payload, TIMEOUT_MS.fs)
}
async function fsRename (from: string, to: string): Promise<void> { await call('fs.rename', { from, to }, TIMEOUT_MS.fs) }

/**
 * ADR-0016's one synchronous call. `ipcRenderer.sendSync` blocks THIS
 * RENDERER until ../broker/transport/sync-fs.ts's main-process handler
 * replies -- the required behaviour, not a bug, so this deliberately has no
 * timeout wrapper the way `call()` above does: a timeout on a call that
 * cannot be cancelled could only ever lie about a reply that has not
 * arrived yet, and `sync-fs.ts`'s own header explains why nothing on this
 * path may suspend in the first place.
 *
 * RETURNS THE ENVELOPE, NEVER THROWS -- unlike every other method here.
 * Found live (a real Electron launch, not a unit test): a plain object
 * THROWN across `contextBridge`'s function-proxy boundary crosses back as a
 * generic `Error` with only `.message` intact, `.code` silently dropped --
 * a resolved return value does not go through that same handling and
 * crosses as plain data, intact (confirmed by the same launch: a successful
 * read's bytes arrived correctly before this fix). So this function crosses
 * the envelope as data, and whichever caller sits on the SAME side the
 * throw needs to happen on builds the real `OrivonError` there:
 * `../main-world-socket.ts`'s `installOrivon` does this for the
 * `executeInMainWorld` path (see its own `readFileSync`, reusing its own
 * `toOrivonError`); `fsReadFileSyncThrowing` below does it for
 * `exposeFallback`.
 */
function fsReadFileSyncEnvelope (path: string): ResponseEnvelope<Uint8Array> {
  return ipcRenderer.sendSync(SYNC_CONTROL_CHANNEL, { path }) as ResponseEnvelope<Uint8Array>
}

/**
 * `exposeFallback`'s own `readFileSync`: throws in the isolated world, built
 * the same way `call()` builds one, so an app's `catch` sees an identical
 * shape whichever `fs` method failed. Only used when `executeInMainWorld` is
 * absent or throws -- there is no main-world code running in that case (that
 * is the whole reason `installOrivon` never runs) for the throw to happen
 * inside instead, unlike `fsReadFileSyncEnvelope`'s other caller.
 */
function fsReadFileSyncThrowing (path: string): Uint8Array {
  const response = fsReadFileSyncEnvelope(path)
  if (response.ok) return response.result
  throw toOrivonError(response.code, response.platformCode === undefined
    ? { message: response.message }
    : { message: response.message, platformCode: response.platformCode })
}

async function idPublicKey (curve: string): Promise<Uint8Array> { return await call('id.publicKey', { curve }, TIMEOUT_MS.id) }
async function idSign (curve: string, payload: Uint8Array): Promise<Uint8Array> {
  return await call('id.sign', { curve, payload }, TIMEOUT_MS.id)
}

/** The `net`-less surface: used both when `executeInMainWorld` is absent and when it exists but throws -- one implementation, not two copies quietly drifting apart. */
function exposeFallback (): void {
  contextBridge.exposeInMainWorld('orivon', {
    version: 0,
    app: { manifest: appManifest, grants: appGrants, requestGrant: appRequestGrant },
    fs: {
      readFile: fsReadFile,
      writeFile: fsWriteFile,
      readFileSync: fsReadFileSyncThrowing,
      mkdir: fsMkdir,
      readdir: fsReaddir,
      stat: fsStat,
      rm: fsRm,
      rename: fsRename
    },
    id: {
      publicKey: async (opts: { curve: string }) => await idPublicKey(opts.curve),
      sign: async (opts: { curve: string, payload: Uint8Array }) => await idSign(opts.curve, opts.payload)
    }
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
    appRequestGrant,
    fsReadFile,
    fsWriteFile,
    fsReadFileSync: fsReadFileSyncEnvelope,
    fsMkdir,
    fsReaddir,
    fsStat,
    fsRm,
    fsRename,
    idPublicKey,
    idSign,
    netConnect: netConnectBridge,
    netConnectSecure: netConnectSecureBridge,
    netUdpBind: netUdpBindBridge,
    netListen: netListenBridge
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
