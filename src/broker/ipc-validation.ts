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

/** The six wired control operations. Anything else is 'invalid'. */
export type ControlMethod = 'app.manifest' | 'app.grants' | 'fs.readFile' | 'fs.writeFile' | 'net.connect' | 'net.close'

export function isControlMethod (method: string): method is ControlMethod {
  return method === 'app.manifest' || method === 'app.grants' ||
    method === 'fs.readFile' || method === 'fs.writeFile' ||
    method === 'net.connect' || method === 'net.close'
}

export interface FsReadFileParams { readonly path: string }
export interface FsWriteFileParams { readonly path: string, readonly data: Uint8Array }
export interface NetConnectParams { readonly host: string, readonly port: number }
export interface NetCloseParams { readonly id: string }

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

export function isNetCloseParams (payload: unknown): payload is NetCloseParams {
  return typeof payload === 'object' && payload !== null &&
    typeof (payload as { id?: unknown }).id === 'string'
}
