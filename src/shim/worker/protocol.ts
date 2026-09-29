// The messages between a page and a Worker it runs a child in. Two
// channels: the Worker's own postMessage for control, stdio and IPC, and a
// MessagePort that carries the Worker's orivon.* calls to the page
// (orivon-server.ts, orivon-client.ts).

/** What a Worker is handed to run: a compiled preview1 module, or where a component's jco output is. */
export type SpawnProgram =
  | { readonly kind: 'core', readonly module: WebAssembly.Module }
  /** `glue` is the output's JavaScript, `base` the URL its core modules are named against. */
  | { readonly kind: 'component', readonly glue: string, readonly base: string }

/** Runs a WASI program: a preview1 module compiled on the page, or a component's jco output the Worker imports. */
export interface SpawnStart {
  readonly type: 'spawn'
  readonly program: SpawnProgram
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

/** Imports an app module as a `worker_threads` thread: Node's `process`, minus IPC, plus `parentPort` and `workerData`. */
export interface ThreadStart {
  readonly type: 'thread'
  /** Absolute URL of the module; a blob Worker has no base URL of the app's. */
  readonly url: string
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  readonly threadId: number
  readonly workerData: unknown
  readonly name: string
  /** The thread's end of a `MessageChannel` whose other end is the `Worker` instance. */
  readonly parentPort: MessagePort
  readonly orivon: MessagePort
  /** Whether the matching `Worker` option was set: false routes that stream to the parent's own instead of piping it. */
  readonly stdin: boolean
  readonly stdout: boolean
  readonly stderr: boolean
}

export type StreamName = 'stdout' | 'stderr'

export type ToWorker =
  | SpawnStart
  | ForkStart
  | ThreadStart
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
  /** An uncaught error or rejection, raw rather than a WireError: Chromium structured-clones an Error, which a worker_threads.Worker's 'error' event wants as itself, not a plain record. */
  | { readonly type: 'crash', readonly error: unknown }
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
