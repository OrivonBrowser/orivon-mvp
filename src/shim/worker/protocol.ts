// The messages between a page and a Worker it runs a child in. Two
// channels: the Worker's own postMessage for control, stdio and IPC, and a
// MessagePort that carries the Worker's orivon.* calls to the page
// (orivon-server.ts, orivon-client.ts).

/** Runs a WASI program: `module` is compiled on the page, so the Worker only instantiates it. */
export interface SpawnStart {
  readonly type: 'spawn'
  readonly module: WebAssembly.Module
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly preopens: Readonly<Record<string, string>>
  readonly orivon: MessagePort
}

/** Imports an app module as a child with Node's `process` around it. */
export interface ForkStart {
  readonly type: 'fork'
  /** Absolute URL of the module; a blob Worker has no base URL of the app's. */
  readonly url: string
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  readonly serialization: 'json' | 'advanced'
  readonly orivon: MessagePort
}

export type StreamName = 'stdout' | 'stderr'

export type ToWorker =
  | SpawnStart
  | ForkStart
  | { readonly type: 'stdin', readonly data: Uint8Array }
  | { readonly type: 'stdin-end' }
  /** The page has taken the last chunk of `stream`: the Worker may send the next. */
  | { readonly type: 'ack', readonly stream: StreamName }
  | { readonly type: 'ipc', readonly message: unknown }
  | { readonly type: 'disconnect' }

export interface WireError {
  readonly name: string
  readonly message: string
  readonly code?: string
}

export type FromWorker =
  | { readonly type: 'started' }
  | { readonly type: 'output', readonly stream: StreamName, readonly data: Uint8Array }
  /** `signal` is set when the child did not end by returning or calling exit. */
  | { readonly type: 'exit', readonly code: number | null, readonly signal: string | null }
  | { readonly type: 'failed', readonly error: WireError }
  | { readonly type: 'ipc', readonly message: unknown }
  | { readonly type: 'disconnect' }

export function toWireError (error: unknown): WireError {
  if (typeof error !== 'object' || error === null) return { name: 'Error', message: String(error) }
  const { name, message, code } = error as { name?: unknown, message?: unknown, code?: unknown }
  return {
    name: typeof name === 'string' ? name : 'Error',
    message: typeof message === 'string' ? message : String(error),
    ...(typeof code === 'string' ? { code } : {})
  }
}
