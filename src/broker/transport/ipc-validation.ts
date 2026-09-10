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

import type { RequestEnvelope } from '../../contracts/index.js'

/** The seventeen wired control operations. Anything else is 'invalid'. */
export type ControlMethod =
  | 'app.manifest' | 'app.grants' | 'fs.readFile' | 'fs.writeFile'
  | 'fs.mkdir' | 'fs.readdir' | 'fs.stat' | 'fs.rm' | 'fs.rename'
  | 'id.publicKey' | 'id.sign'
  | 'net.connect' | 'net.connectSecure' | 'net.udpBind' | 'net.close'
  | 'net.setNoDelay' | 'net.setKeepAlive'

export function isControlMethod (method: string): method is ControlMethod {
  return method === 'app.manifest' || method === 'app.grants' ||
    method === 'fs.readFile' || method === 'fs.writeFile' ||
    method === 'fs.mkdir' || method === 'fs.readdir' || method === 'fs.stat' ||
    method === 'fs.rm' || method === 'fs.rename' ||
    method === 'id.publicKey' || method === 'id.sign' ||
    method === 'net.connect' || method === 'net.connectSecure' ||
    method === 'net.udpBind' || method === 'net.close' ||
    method === 'net.setNoDelay' || method === 'net.setKeepAlive'
}

export interface FsReadFileParams { readonly path: string }
export interface FsWriteFileParams { readonly path: string, readonly data: Uint8Array }
/** Shared shape for fs.mkdir and fs.rm -- both take just a path and an optional recursive flag. */
export interface FsPathWithRecursiveParams { readonly path: string, readonly recursive?: boolean }
export interface FsReaddirParams { readonly path: string }
export interface FsStatParams { readonly path: string }
export interface FsRenameParams { readonly from: string, readonly to: string }
export interface IdPublicKeyParams { readonly curve: string }
export interface IdSignParams { readonly curve: string, readonly payload: Uint8Array }
/** Shared by net.connect and net.connectSecure -- both take exactly { host, port }, and isNetConnectParams below validates either call's payload (code-guidelines.md Rule 3: same shape, same reason). */
export interface NetConnectParams { readonly host: string, readonly port: number }
/**
 * `port` of 0 is LEGAL here and means "any free port" -- the one place in this
 * file where zero is not a shape error. policy/bind.ts decides what it is
 * allowed to resolve to; this only checks it is an integer in range.
 */
export interface NetUdpBindParams { readonly port: number }
export interface NetCloseParams { readonly id: string }
export interface NetSetNoDelayParams { readonly id: string, readonly on: boolean }
export interface NetSetKeepAliveParams { readonly id: string, readonly on: boolean, readonly initialDelayMs?: number }

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
