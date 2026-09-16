// Everything that decides whether a message from an untrusted renderer is
// well-formed. Split out of ./ipc.ts under code-guidelines.md Rule 2 -- by
// concern, not by line count: this is one job (shape validation at the trust
// boundary) and ./ipc.ts keeps the other (dispatch, wiring, the subsystem).
//
// WHY THESE GUARDS EXIST AT ALL, restated here because this file is now the
// place a reader meets them first: contextBridge only gates what a PAGE's JS
// can construct. A compromised renderer PROCESS reaches CONTROL_CHANNEL
// directly over Chromium's own IPC pipe, so nothing arriving there is
// trusted because the preload is well-behaved -- not the payload, and not
// the envelope carrying it.

import type { CapabilityRequest, Pattern, RequestEnvelope } from '../../contracts/index.js'
import { MAX_PATTERNS } from '../policy/connect.js'

/**
 * The wired control operations. Anything else is 'invalid'.
 *
 * The `fs.dir*` eight (A195) are `DirectoryHandle`'s own method set
 * (`contracts/handles.ts`) reaching CONTROL_CHANNEL -- one case per member,
 * each carrying the picked folder's handle `id` the same way `fs.read`/
 * `fs.write`/... already carry a file's. `fs.dirOpen` is the one that does
 * NOT get a matching `fs.dir*` sibling of its own for what it returns: it
 * resolves a `FileHandle`, so every subsequent call against it is `fs.read`/
 * `fs.write`/`fs.fstat`/`fs.truncate`/`fs.sync`/`fs.close` -- fs.open's own
 * six, reused for free (A194's own dispatch-fs.ts comment on why that is
 * the correct reuse, not a second mechanism).
 */
export type ControlMethod =
  | 'app.manifest' | 'app.grants' | 'app.requestGrant' | 'fs.readFile' | 'fs.writeFile'
  | 'fs.mkdir' | 'fs.readdir' | 'fs.stat' | 'fs.rm' | 'fs.rename'
  | 'fs.open' | 'fs.read' | 'fs.write' | 'fs.fstat' | 'fs.truncate' | 'fs.sync' | 'fs.close'
  | 'fs.userSelected'
  | 'fs.dirReaddir' | 'fs.dirStat' | 'fs.dirMkdir' | 'fs.dirRm' | 'fs.dirRename'
  | 'fs.dirReadFile' | 'fs.dirWriteFile' | 'fs.dirOpen'
  | 'id.publicKey' | 'id.sign'
  | 'net.connect' | 'net.connectSecure' | 'net.udpBind' | 'net.listen' | 'net.close'
  | 'net.setNoDelay' | 'net.setKeepAlive' | 'net.lookup'

export function isControlMethod (method: string): method is ControlMethod {
  return method === 'app.manifest' || method === 'app.grants' || method === 'app.requestGrant' ||
    method === 'fs.readFile' || method === 'fs.writeFile' ||
    method === 'fs.mkdir' || method === 'fs.readdir' || method === 'fs.stat' ||
    method === 'fs.rm' || method === 'fs.rename' ||
    method === 'fs.open' || method === 'fs.read' || method === 'fs.write' ||
    method === 'fs.fstat' || method === 'fs.truncate' || method === 'fs.sync' || method === 'fs.close' ||
    method === 'fs.userSelected' ||
    method === 'fs.dirReaddir' || method === 'fs.dirStat' || method === 'fs.dirMkdir' ||
    method === 'fs.dirRm' || method === 'fs.dirRename' || method === 'fs.dirReadFile' ||
    method === 'fs.dirWriteFile' || method === 'fs.dirOpen' ||
    method === 'id.publicKey' || method === 'id.sign' ||
    method === 'net.connect' || method === 'net.connectSecure' ||
    method === 'net.udpBind' || method === 'net.listen' || method === 'net.close' ||
    method === 'net.setNoDelay' || method === 'net.setKeepAlive' ||
    method === 'net.lookup'
}

export interface FsReadFileParams { readonly path: string }
export interface FsWriteFileParams { readonly path: string, readonly data: Uint8Array }
/** Shared shape for fs.mkdir and fs.rm -- both take just a path and an optional recursive flag. */
export interface FsPathWithRecursiveParams { readonly path: string, readonly recursive?: boolean }
export interface FsReaddirParams { readonly path: string }
export interface FsStatParams { readonly path: string }
export interface FsRenameParams { readonly from: string, readonly to: string }
export interface FsOpenParams { readonly path: string, readonly flags: string }
/**
 * `orivon.fs.userSelected`'s wire payload -- both `directory` and `multiple`
 * optional, matching `capability-api.ts`'s own overload split (`{directory:
 * true}` for a folder, `{directory?: false, multiple?: boolean}` for files).
 * Shape validation accepts EITHER call; `dispatch-fs.ts`'s own case routes
 * `directory: true` to a `DirectoryHandle` acquisition (A195) and everything
 * else to the pre-existing file shape.
 */
export interface FsUserSelectedParams { readonly directory?: boolean, readonly multiple?: boolean }
/** Shared by fs.fstat, fs.sync and fs.close -- all three name only the handle. */
export interface FsHandleIdParams { readonly id: string }
export interface FsHandleReadParams { readonly id: string, readonly position: number, readonly length: number }
export interface FsHandleWriteParams { readonly id: string, readonly position: number, readonly data: Uint8Array }
export interface FsHandleTruncateParams { readonly id: string, readonly length: number }

/**
 * `DirectoryHandle`'s own eight-method wire payloads (A195), each carrying
 * the picked folder's handle `id` alongside whatever `path` its
 * `contracts/handles.ts` signature already takes. `path` is OPTIONAL only on
 * `fs.dirReaddir`/`fs.dirStat` -- `DirectoryHandle.readdir`/`stat` omitting
 * it targets the root itself (that interface's own doc comment); every other
 * member requires one, matching its signature exactly.
 */
export interface FsDirPathOptionalParams { readonly id: string, readonly path?: string }
export interface FsDirPathRequiredParams { readonly id: string, readonly path: string }
/** Shared by fs.dirMkdir and fs.dirRm -- both take a path and an optional recursive flag, mirroring FsPathWithRecursiveParams one layer up. */
export interface FsDirPathWithRecursiveParams { readonly id: string, readonly path: string, readonly recursive?: boolean }
export interface FsDirRenameParams { readonly id: string, readonly from: string, readonly to: string }
export interface FsDirWriteFileParams { readonly id: string, readonly path: string, readonly data: Uint8Array }
export interface FsDirOpenParams { readonly id: string, readonly path: string, readonly flags: string }
export interface IdPublicKeyParams { readonly curve: string }
export interface IdSignParams { readonly curve: string, readonly payload: Uint8Array }
/** Shared by net.connect and net.connectSecure -- both take exactly { host, port }, and isNetConnectParams below validates either call's payload (code-guidelines.md Rule 3: same shape, same reason). */
export interface NetConnectParams { readonly host: string, readonly port: number }
/**
 * Shared by net.udpBind and net.listen -- both take exactly `{ port }`, and
 * `isNetUdpBindParams` below validates either call's payload
 * (code-guidelines.md Rule 3: same shape, same reason -- matching
 * `NetConnectParams`' own precedent above for net.connect/net.connectSecure).
 *
 * `port` of 0 is LEGAL here and means "any free port" -- the one place in this
 * file where zero is not a shape error. policy/bind.ts decides what it is
 * allowed to resolve to; this only checks it is an integer in range.
 */
export interface NetUdpBindParams { readonly port: number }
export interface NetCloseParams { readonly id: string }
/** `net.lookup` (d-0030) -- no port, unlike NetConnectParams: a lookup is bounded by the origin's held network grants, never by a port of its own. */
export interface NetLookupParams { readonly hostname: string }
export interface NetSetNoDelayParams { readonly id: string, readonly on: boolean }
export interface NetSetKeepAliveParams { readonly id: string, readonly on: boolean, readonly initialDelayMs?: number }
/** The wire shape of `CapabilityRequest` (capability-api.ts) -- untrusted, including `capability`, which `main/request-grant.ts` narrows against the manifest; this file only checks shape. */
export interface AppRequestGrantParams { readonly capability: string, readonly patterns?: readonly Pattern[] }

/**
 * The one field of `SubsystemContext` (../../main/registry.js)
 * `dispatch-app.ts`'s 'app.requestGrant' case needs, read via THIS object's
 * own live getter on every call rather than captured once: `registerBrokerIpc`
 * runs before request-grant-subsystem publishes it (subsystems.ts's own
 * ordering comment), so grabbing the value at wiring time would freeze it at
 * `undefined` forever. A real `SubsystemContext` satisfies this shape
 * structurally; ipc.test.ts needs only a plain object with this one field.
 * Lives here, alongside the payload shape it pairs with, rather than in
 * dispatch-app.ts: both ipc.ts's `handleControlRequest` and dispatch-app.ts's
 * `dispatchApp` need this same type, so it lives in the shared validation
 * module rather than in either one.
 */
export interface RequestGrantCtx {
  readonly requestGrant: ((origin: string, request: CapabilityRequest) => Promise<boolean>) | undefined
}

export function isNetUdpBindParams (payload: unknown): payload is NetUdpBindParams {
  if (typeof payload !== 'object' || payload === null) return false
  const port = (payload as { port?: unknown }).port
  return typeof port === 'number' && Number.isInteger(port) && port >= 0 && port <= 65535
}

export function isFsReadFileParams (payload: unknown): payload is FsReadFileParams {
  return typeof payload === 'object' && payload !== null &&
    typeof (payload as { path?: unknown }).path === 'string'
}

export function isFsWriteFileParams (payload: unknown): payload is FsWriteFileParams {
  return typeof payload === 'object' && payload !== null &&
    typeof (payload as { path?: unknown }).path === 'string' &&
    (payload as { data?: unknown }).data instanceof Uint8Array
}

/**
 * `recursive` is OPTIONAL, matching `capability-api.ts`'s
 * `opts?: { recursive?: boolean }` on both `mkdir` and `rm` -- an
 * `exactOptionalPropertyTypes`-safe check, so a payload that omits the key
 * entirely is just as valid as one carrying `recursive: false`.
 */
export function isFsPathWithRecursiveParams (payload: unknown): payload is FsPathWithRecursiveParams {
  if (typeof payload !== 'object' || payload === null) return false
  const { path, recursive } = payload as { path?: unknown, recursive?: unknown }
  return typeof path === 'string' && (recursive === undefined || typeof recursive === 'boolean')
}

export function isFsReaddirParams (payload: unknown): payload is FsReaddirParams {
  return typeof payload === 'object' && payload !== null &&
    typeof (payload as { path?: unknown }).path === 'string'
}

export function isFsStatParams (payload: unknown): payload is FsStatParams {
  return typeof payload === 'object' && payload !== null &&
    typeof (payload as { path?: unknown }).path === 'string'
}

export function isFsRenameParams (payload: unknown): payload is FsRenameParams {
  return typeof payload === 'object' && payload !== null &&
    typeof (payload as { from?: unknown }).from === 'string' &&
    typeof (payload as { to?: unknown }).to === 'string'
}

export function isFsOpenParams (payload: unknown): payload is FsOpenParams {
  return typeof payload === 'object' && payload !== null &&
    typeof (payload as { path?: unknown }).path === 'string' &&
    typeof (payload as { flags?: unknown }).flags === 'string'
}

export function isFsUserSelectedParams (payload: unknown): payload is FsUserSelectedParams {
  if (typeof payload !== 'object' || payload === null) return false
  const { directory, multiple } = payload as { directory?: unknown, multiple?: unknown }
  return (directory === undefined || typeof directory === 'boolean') &&
    (multiple === undefined || typeof multiple === 'boolean')
}

export function isFsHandleIdParams (payload: unknown): payload is FsHandleIdParams {
  return typeof payload === 'object' && payload !== null &&
    typeof (payload as { id?: unknown }).id === 'string'
}

/**
 * `position`/`length` are bounded to safe integers, never merely "a number"
 * -- `handle.read`'s own contract is explicit position, so `NaN`, `Infinity`
 * or a negative offset reaching the adapter is this file's job to refuse,
 * not `fs-capability.ts`'s (T1/T10's discipline: fail closed at the trust
 * boundary, not two layers in).
 */
export function isFsHandleReadParams (payload: unknown): payload is FsHandleReadParams {
  if (typeof payload !== 'object' || payload === null) return false
  const { id, position, length } = payload as { id?: unknown, position?: unknown, length?: unknown }
  return typeof id === 'string' &&
    typeof position === 'number' && Number.isSafeInteger(position) && position >= 0 &&
    typeof length === 'number' && Number.isSafeInteger(length) && length >= 0
}

export function isFsHandleWriteParams (payload: unknown): payload is FsHandleWriteParams {
  if (typeof payload !== 'object' || payload === null) return false
  const { id, position, data } = payload as { id?: unknown, position?: unknown, data?: unknown }
  return typeof id === 'string' &&
    typeof position === 'number' && Number.isSafeInteger(position) && position >= 0 &&
    data instanceof Uint8Array
}

export function isFsHandleTruncateParams (payload: unknown): payload is FsHandleTruncateParams {
  if (typeof payload !== 'object' || payload === null) return false
  const { id, length } = payload as { id?: unknown, length?: unknown }
  return typeof id === 'string' && typeof length === 'number' && Number.isSafeInteger(length) && length >= 0
}

/** Shared by fs.dirReaddir and fs.dirStat -- `path` optional, matching `DirectoryHandle.readdir`/`stat` (contracts/handles.ts). */
export function isFsDirPathOptionalParams (payload: unknown): payload is FsDirPathOptionalParams {
  if (typeof payload !== 'object' || payload === null) return false
  const { id, path } = payload as { id?: unknown, path?: unknown }
  return typeof id === 'string' && (path === undefined || typeof path === 'string')
}

/** fs.dirReadFile -- `path` required, unlike the optional-path pair above. */
export function isFsDirPathRequiredParams (payload: unknown): payload is FsDirPathRequiredParams {
  return typeof payload === 'object' && payload !== null &&
    typeof (payload as { id?: unknown }).id === 'string' &&
    typeof (payload as { path?: unknown }).path === 'string'
}

/** Shared by fs.dirMkdir and fs.dirRm, `recursive` optional -- FsPathWithRecursiveParams's own reasoning, one layer down. */
export function isFsDirPathWithRecursiveParams (payload: unknown): payload is FsDirPathWithRecursiveParams {
  if (typeof payload !== 'object' || payload === null) return false
  const { id, path, recursive } = payload as { id?: unknown, path?: unknown, recursive?: unknown }
  return typeof id === 'string' && typeof path === 'string' &&
    (recursive === undefined || typeof recursive === 'boolean')
}

export function isFsDirRenameParams (payload: unknown): payload is FsDirRenameParams {
  return typeof payload === 'object' && payload !== null &&
    typeof (payload as { id?: unknown }).id === 'string' &&
    typeof (payload as { from?: unknown }).from === 'string' &&
    typeof (payload as { to?: unknown }).to === 'string'
}

export function isFsDirWriteFileParams (payload: unknown): payload is FsDirWriteFileParams {
  return typeof payload === 'object' && payload !== null &&
    typeof (payload as { id?: unknown }).id === 'string' &&
    typeof (payload as { path?: unknown }).path === 'string' &&
    (payload as { data?: unknown }).data instanceof Uint8Array
}

export function isFsDirOpenParams (payload: unknown): payload is FsDirOpenParams {
  return typeof payload === 'object' && payload !== null &&
    typeof (payload as { id?: unknown }).id === 'string' &&
    typeof (payload as { path?: unknown }).path === 'string' &&
    typeof (payload as { flags?: unknown }).flags === 'string'
}

export function isIdPublicKeyParams (payload: unknown): payload is IdPublicKeyParams {
  return typeof payload === 'object' && payload !== null &&
    typeof (payload as { curve?: unknown }).curve === 'string'
}

export function isIdSignParams (payload: unknown): payload is IdSignParams {
  return typeof payload === 'object' && payload !== null &&
    typeof (payload as { curve?: unknown }).curve === 'string' &&
    (payload as { payload?: unknown }).payload instanceof Uint8Array
}

export function isNetConnectParams (payload: unknown): payload is NetConnectParams {
  return typeof payload === 'object' && payload !== null &&
    typeof (payload as { host?: unknown }).host === 'string' &&
    typeof (payload as { port?: unknown }).port === 'number'
}

export function isNetSetNoDelayParams (payload: unknown): payload is NetSetNoDelayParams {
  return typeof payload === 'object' && payload !== null &&
    typeof (payload as { id?: unknown }).id === 'string' &&
    typeof (payload as { on?: unknown }).on === 'boolean'
}

export function isNetSetKeepAliveParams (payload: unknown): payload is NetSetKeepAliveParams {
  if (typeof payload !== 'object' || payload === null) return false
  const { id, on, initialDelayMs } = payload as { id?: unknown, on?: unknown, initialDelayMs?: unknown }
  return typeof id === 'string' && typeof on === 'boolean' &&
    (initialDelayMs === undefined ||
      (typeof initialDelayMs === 'number' && Number.isInteger(initialDelayMs) && initialDelayMs >= 0))
}

export function isNetCloseParams (payload: unknown): payload is NetCloseParams {
  return typeof payload === 'object' && payload !== null &&
    typeof (payload as { id?: unknown }).id === 'string'
}

export function isNetLookupParams (payload: unknown): payload is NetLookupParams {
  return typeof payload === 'object' && payload !== null &&
    typeof (payload as { hostname?: unknown }).hostname === 'string'
}

/**
 * `patterns` bounded by `MAX_PATTERNS` (A119) -- the same ceiling a
 * manifest's own declared patterns are held to (`loader/manifest-
 * capabilities.ts`), reused rather than reimplemented (Rule 3) so a caller
 * cannot run `decideGrantRequest`'s subset check against an array sized to
 * cost CPU rather than to ever plausibly be approved.
 */
export function isAppRequestGrantParams (payload: unknown): payload is AppRequestGrantParams {
  if (typeof payload !== 'object' || payload === null) return false
  const { capability, patterns } = payload as { capability?: unknown, patterns?: unknown }
  if (typeof capability !== 'string') return false
  if (patterns === undefined) return true
  return Array.isArray(patterns) && patterns.length <= MAX_PATTERNS &&
    patterns.every((pattern) => typeof pattern === 'string')
}

/**
 * setTimeout's own ceiling. Above it Node clamps the delay to 1ms and warns,
 * so a caller asking for a 2^40ms budget would be answered 'timeout' almost
 * immediately -- the opposite of what it asked for. Rejected as malformed
 * rather than silently reinterpreted in either direction.
 */
const MAX_TIMEOUT_MS = 2_147_483_647

/** Best-effort id for a malformed envelope, so even a rejection can be correlated. */
export function envelopeId (value: unknown): string {
  return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string'
    ? (value as { id: string }).id
    : ''
}

export function isRequestEnvelope (value: unknown): value is RequestEnvelope<unknown> {
  if (typeof value !== 'object' || value === null) return false
  const { id, method, timeoutMs } = value as { id?: unknown, method?: unknown, timeoutMs?: unknown }
  return typeof id === 'string' && typeof method === 'string' &&
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) &&
    timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS
}
