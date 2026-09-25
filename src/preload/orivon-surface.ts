import { contextBridge, ipcRenderer } from 'electron'
import { SYNC_CONTROL_CHANNEL } from '../main/channels.js'
import { installOrivon } from './main-world-socket.js'
import type { MainWorldDirectoryBridge, MainWorldFileBridge } from './main-world-socket.js'
import { call, TIMEOUT_MS } from './control-call.js'
import { netConnectBridge, netConnectSecureBridge, netListenBridge, netLookupBridge, netUdpBindBridge } from './net-surface.js'
import { webOpenContextBridge } from './web-surface.js'
import type { MainWorldWebContextBridge } from './web-surface.js'
import type { CapabilityRequest, FileStat, Grant, Manifest, OrivonErrorCode } from '../contracts/index.js'
import { LIMITS } from '../contracts/index.js'
import type { ResponseEnvelope } from '../contracts/ipc.js'
import { toOrivonError } from './orivon-error.js'

// The real orivon.* surface, shared by preload/app.ts and preload/newtab.ts's
// fallback branch. See README.md's Design notes section for why this file
// is shaped the way it is (the two-world split, the CONTROL_CHANNEL import
// source, what is and isn't wired yet, and how it splits across
// ./control-call.ts and ./net-surface.ts).
//
// Nothing below hands the page anything but a Promise-returning closure,
// with ONE exception -- ADR-0016's deliberately narrow synchronous call,
// still never touching `ipcRenderer` directly from the PAGE (it stays a
// plain proxied closure, exactly like every other method here; only this
// preload script's own `fsReadFileSyncEnvelope` touches `ipcRenderer.
// sendSync` itself). It is SPLIT INTO TWO FUNCTIONS,
// `fsReadFileSyncEnvelope`/`fsReadFileSyncThrowing` -- see their own docs --
// because a THROWN value does not survive `contextBridge`'s function-proxy
// boundary intact (found live, not in a unit test); a RETURNED one does, so
// the envelope crosses as data and the real `OrivonError` is thrown on
// whichever side of the boundary the call already ends up on.
// `./control-call.ts`'s `call()` is the only thing that touches
// `ipcRenderer.invoke` (the raw MessagePortMain/ipcRenderer never crossing
// into the main world is this whole directory's rule, not just this
// file's); each method's own timeout budget lives there too. net.listen's
// own bridge closure (netListenBridge) lives in ./net-surface.ts alongside
// net.connect/net.udpBind/net.lookup's, for the same reason.

async function appManifest (): Promise<Manifest> { return await call('app.manifest', undefined, TIMEOUT_MS.metadata) }
async function appGrants (): Promise<readonly Grant[]> { return await call('app.grants', undefined, TIMEOUT_MS.metadata) }
/**
 * `request.patterns` is flattened the same way `net-surface.ts`'s
 * `setKeepAlive`'s `initialDelayMs` is: `exactOptionalPropertyTypes` treats an
 * explicit `patterns: undefined` as different from the key being absent, and
 * only the absent form means "whatever the manifest already declares"
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

/** `fs.open`'s CONTROL_CHANNEL reply -- deliberately just an id, matching net-surface.ts's own SocketDescriptor: `read`/`write`/... are built below as plain proxied closures, not carried across this call. */
interface FsHandleDescriptor { readonly id: string }

/**
 * `orivon.fs.open` (A184). No main-world stream wrapping needed -- exactly
 * fs.readFile/writeFile's own reasoning above -- because THIS handle has
 * none yet: `readable`/`writable` have no CONTROL_CHANNEL case in this
 * lane's own landing, so the object below is deliberately narrower than
 * `FileHandle` (contracts/handles.ts). See this lane's PR body for what
 * that means and what does not yet reach a page.
 */
/**
 * Wraps an already-opened handle's `id` into the closures `fsOpen` and
 * `fsUserSelected` both need -- identical wiring either way, since a picked
 * file's handle lands in the SAME broker-side registry `fs.open`'s own does
 * (fs-handle-wrapper.ts: one `FailableFileHandle` shape, shared) and the
 * same fs.read/write/fstat/truncate/sync/close cases serve both (Rule 3:
 * one implementation, not two copies of this object literal).
 */
function buildFileBridge (id: string): MainWorldFileBridge {
  return {
    id,
    read: async (opts) => await call('fs.read', { id, position: opts.position, length: opts.length }, TIMEOUT_MS.fs),
    write: async (opts) => await call('fs.write', { id, position: opts.position, data: opts.data }, TIMEOUT_MS.fs),
    stat: async () => await call('fs.fstat', { id }, TIMEOUT_MS.fs),
    truncate: async (length) => { await call('fs.truncate', { id, length }, TIMEOUT_MS.fs) },
    sync: async () => { await call('fs.sync', { id }, TIMEOUT_MS.fs) },
    close: async () => { await call('fs.close', { id }, TIMEOUT_MS.fs) }
  }
}

async function fsOpen (path: string, flags: string): Promise<MainWorldFileBridge> {
  const descriptor = await call<FsHandleDescriptor>('fs.open', { path, flags }, TIMEOUT_MS.fs)
  return buildFileBridge(descriptor.id)
}

/**
 * A person choosing in an OS picker, like one deciding at a grant prompt,
 * has no natural bound; `fs`'s disk-I/O budget cut them off mid-choice.
 */
const PICKER_TIMEOUT_MS = TIMEOUT_MS.grant

/** `orivon.fs.userSelected`'s FILE shape (A194, d-0032). `exposeFallback`'s own `userSelected` closure routes here for every call except `{ directory: true }`, which goes to `fsUserSelectedDirectory` below (A195). */
async function fsUserSelected (opts?: { multiple?: boolean }): Promise<readonly MainWorldFileBridge[]> {
  const descriptors = await call<readonly FsHandleDescriptor[]>('fs.userSelected', opts ?? {}, PICKER_TIMEOUT_MS)
  return descriptors.map((descriptor) => buildFileBridge(descriptor.id))
}

/**
 * `buildFileBridge`'s own `DirectoryHandle` counterpart (A195, closing
 * A194) -- every member is a plain request/reply round trip over the
 * `fs.dir*` control methods dispatch-fs.ts now wires, so this needs no
 * main-world stream wrapping, exactly like `buildFileBridge` above. `open`
 * resolves through `fs.dirOpen`, then reuses `buildFileBridge` on the id it
 * returns -- the SAME file-handle mechanism `fs.open`/`fs.userSelected`'s
 * file shape already use, not a second one.
 */
function buildDirectoryBridge (id: string): MainWorldDirectoryBridge {
  return {
    id,
    readdir: async (path) => await call('fs.dirReaddir', path === undefined ? { id } : { id, path }, TIMEOUT_MS.fs),
    stat: async (path) => await call('fs.dirStat', path === undefined ? { id } : { id, path }, TIMEOUT_MS.fs),
    mkdir: async (path, opts) => {
      await call('fs.dirMkdir', opts?.recursive === undefined ? { id, path } : { id, path, recursive: opts.recursive }, TIMEOUT_MS.fs)
    },
    rm: async (path, opts) => {
      await call('fs.dirRm', opts?.recursive === undefined ? { id, path } : { id, path, recursive: opts.recursive }, TIMEOUT_MS.fs)
    },
    rename: async (from, to) => { await call('fs.dirRename', { id, from, to }, TIMEOUT_MS.fs) },
    readFile: async (path) => await call('fs.dirReadFile', { id, path }, TIMEOUT_MS.fs),
    writeFile: async (path, data) => { await call('fs.dirWriteFile', { id, path, data }, TIMEOUT_MS.fs) },
    open: async (path, flags) => {
      const descriptor = await call<FsHandleDescriptor>('fs.dirOpen', { id, path, flags }, TIMEOUT_MS.fs)
      return buildFileBridge(descriptor.id)
    },
    close: async () => { await call('fs.close', { id }, TIMEOUT_MS.fs) }
  }
}

/** `orivon.fs.userSelected`'s FOLDER shape (A195). `null` on a cancelled pick, matching capability-api.ts's own folder cancel contract -- never a rejection. */
async function fsUserSelectedDirectory (): Promise<MainWorldDirectoryBridge | null> {
  const descriptor = await call<FsHandleDescriptor | null>('fs.userSelected', { directory: true }, PICKER_TIMEOUT_MS)
  return descriptor === null ? null : buildDirectoryBridge(descriptor.id)
}

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

async function secretsAvailable (): Promise<boolean> { return await call('secrets.available', undefined, TIMEOUT_MS.secrets) }
async function secretsEncrypt (plaintext: Uint8Array): Promise<Uint8Array> {
  return await call('secrets.encrypt', { plaintext }, TIMEOUT_MS.secrets)
}
async function secretsDecrypt (ciphertext: Uint8Array): Promise<Uint8Array> {
  return await call('secrets.decrypt', { ciphertext }, TIMEOUT_MS.secrets)
}

/**
 * web.context: `OrivonWeb.openContext(origin, options?)` (capability-api.ts)
 * takes `origin` as its own argument -- unlike every other method on this
 * surface, which takes one options object -- so it needs this thin wrapper
 * around `webOpenContextBridge`, which still wants them merged into one
 * `{ origin, width?, height? }` for the CONTROL_CHANNEL payload
 * (web-surface.ts's own `exactOptionalPropertyTypes` flattening). See
 * `exposeFallback`'s own doc on this method for what wiring
 * `webOpenContextBridge` straight through used to do instead.
 */
async function webOpenContext (origin: string, options?: { width?: number, height?: number }): Promise<MainWorldWebContextBridge> {
  const opts: { origin: string, width?: number, height?: number } = { origin }
  if (options?.width !== undefined) opts.width = options.width
  if (options?.height !== undefined) opts.height = options.height
  return await webOpenContextBridge(opts)
}

/**
 * The stream-less `net` surface: used both when `executeInMainWorld` is
 * absent and when it exists but throws -- one implementation, not two
 * copies quietly drifting apart. `net.lookup` (d-0030) is included here,
 * unlike `connect`/`connectSecure`/`udpBind`: it resolves to plain data,
 * never a live handle, so it needs none of the main-world stream wrapping
 * that makes the other three unsafe to expose without `executeInMainWorld`
 * (`exposeOrivon`'s own doc below) -- exactly `fs.readFile`'s own reasoning.
 */
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
      rename: fsRename,
      open: fsOpen,
      // Routes on `opts?.directory`, matching capability-api.ts's own
      // overload split (A195) -- `fsUserSelectedDirectory` for the folder
      // shape, `fsUserSelected` (unchanged) for the file one.
      userSelected: async (opts?: { directory?: boolean, multiple?: boolean }) => {
        if (opts?.directory === true) return await fsUserSelectedDirectory()
        return await fsUserSelected(opts?.multiple === undefined ? undefined : { multiple: opts.multiple })
      }
    },
    id: {
      publicKey: async (opts: { curve: string }) => await idPublicKey(opts.curve),
      sign: async (opts: { curve: string, payload: Uint8Array }) => await idSign(opts.curve, opts.payload)
    },
    secrets: {
      available: secretsAvailable,
      encrypt: secretsEncrypt,
      decrypt: secretsDecrypt
    },
    net: {
      lookup: async (opts: { hostname: string }) => await netLookupBridge(opts)
    },
    // Included here despite net.connect/etc. above being excluded: unlike
    // those, WebContext needs no main-world-native stream (web-surface.ts's
    // own header) -- exactly fs.open's own reasoning for staying in this
    // fallback path.
    //
    // web.context: `OrivonWeb.openContext` (capability-api.ts) is the one
    // capability on this whole surface that DOESN'T take a single options
    // object -- `origin` is its own positional argument, `options` a
    // separate, optional one. Wiring `webOpenContextBridge` (which takes one
    // merged `{ origin, width?, height? }`) straight through as `openContext`
    // silently dropped `origin` (a bare string has no `.origin` field), so
    // every call reached the broker as `{ origin: undefined }` and was
    // rejected 'invalid'. `webOpenContext` above restores the contract's
    // own two-argument shape.
    web: {
      openContext: webOpenContext
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
    fsOpen,
    fsUserSelected,
    fsUserSelectedDirectory,
    idPublicKey,
    idSign,
    secretsAvailable,
    secretsEncrypt,
    secretsDecrypt,
    webOpenContext: webOpenContextBridge,
    netConnect: netConnectBridge,
    netConnectSecure: netConnectSecureBridge,
    netUdpBind: netUdpBindBridge,
    netListen: netListenBridge,
    netLookup: netLookupBridge
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
