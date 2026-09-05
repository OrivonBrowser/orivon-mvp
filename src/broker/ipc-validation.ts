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

import type { RequestEnvelope } from '../contracts/index.js'

/** The eight wired control operations. Anything else is 'invalid'. */
export type ControlMethod =
  | 'app.manifest' | 'app.grants' | 'fs.readFile' | 'fs.writeFile'
  | 'net.connect' | 'net.close' | 'net.setNoDelay' | 'net.setKeepAlive'

export function isControlMethod (method: string): method is ControlMethod {
  return method === 'app.manifest' || method === 'app.grants' ||
    method === 'fs.readFile' || method === 'fs.writeFile' ||
    method === 'net.connect' || method === 'net.close' ||
    method === 'net.setNoDelay' || method === 'net.setKeepAlive'
}

export interface FsReadFileParams { readonly path: string }
export interface FsWriteFileParams { readonly path: string, readonly data: Uint8Array }
export interface NetConnectParams { readonly host: string, readonly port: number }
export interface NetCloseParams { readonly id: string }
export interface NetSetNoDelayParams { readonly id: string, readonly on: boolean }
export interface NetSetKeepAliveParams { readonly id: string, readonly on: boolean, readonly initialDelayMs?: number }

export function isFsReadFileParams (payload: unknown): payload is FsReadFileParams {
  return typeof payload === 'object' && payload !== null &&
    typeof (payload as { path?: unknown }).path === 'string'
}

export function isFsWriteFileParams (payload: unknown): payload is FsWriteFileParams {
  return typeof payload === 'object' && payload !== null &&
    typeof (payload as { path?: unknown }).path === 'string' &&
    (payload as { data?: unknown }).data instanceof Uint8Array
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
    (initialDelayMs === undefined || typeof initialDelayMs === 'number')
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
