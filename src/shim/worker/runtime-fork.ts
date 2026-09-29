// Inside the Worker: gives an app module the Node process a forked child
// has (argv, env, send/'message', disconnect, exit, stdio) and the same
// shim globals and orivon an app tab has, then imports it. setupChildProcess
// is the part a thread needs too (runtime-thread.ts): argv/env/cwd, output
// posting, process.exit ending only the child, and uncaught-error handling.
// IPC (send/connected/disconnect) is fork-only, since a thread has none.

import { Buffer } from 'buffer'
import { Readable } from 'stream'
import { installGlobals } from '../globals.js'
import type { GlobalsTarget, ShimProcess } from '../globals-types.js'
import { VIRTUAL_ROOT, VIRTUAL_TMPDIR } from '../virtual-root.js'
import { Liveness, trackScope } from './liveness.js'
import { createOrivonClient } from './orivon-client.js'
import type { ParentChannel } from './parent.js'
import { FORK_LIVENESS_SYMBOL } from './symbols.js'
import type { ForkStart, StreamName, ToWorker } from './protocol.js'

export interface ForkScope extends GlobalsTarget {
  orivon?: unknown
  Buffer?: unknown
  setTimeout?: (handler: () => void, ms?: number, ...args: unknown[]) => unknown
  clearTimeout?: (id: unknown) => void
  setInterval?: (handler: () => void, ms?: number, ...args: unknown[]) => unknown
  clearInterval?: (id: unknown) => void
  fetch?: (...args: never[]) => Promise<unknown>
  close (): void
  addEventListener (type: 'error' | 'unhandledrejection', listener: (event: Event) => void): void
}

type SendCallback = (error: Error | null) => void

/** Thrown by process.exit to unwind the code after it; the runtime swallows it. */
class ChildExit extends Error {}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

type BaseProcess = Mutable<ShimProcess> & { stdin: Readable }

interface ForkProcess extends BaseProcess {
  connected: boolean
  send (message: unknown, ...rest: unknown[]): boolean
  disconnect (): void
}

export interface ChildProcessSetup {
  readonly proc: BaseProcess
  readonly liveness: Liveness
  readonly write: (stream: StreamName) => BaseProcess['stdout']['write']
  /** Posts 'exit' and closes the scope; each caller decides what still counts as pending. */
  readonly end: (code: number | null, signal?: string | null) => void
  /** An uncaught error or rejection: an app 'uncaughtException' listener may swallow it, otherwise it ends the child with code 1. */
  readonly crash: (error: unknown) => void
}

function serialize (message: unknown, serialization: ForkStart['serialization']): unknown {
  return serialization === 'json' ? JSON.parse(JSON.stringify(message) ?? 'null') : message
}

/**
 * The Node process a forked child and a thread both get: argv/env/cwd,
 * stdout/stderr posting, process.exit ending only this child, and uncaught
 * errors reaching 'error' the same way Node's would. Node's rule for when a
 * child ends on its own applies to both: nothing pending, and whatever each
 * caller's own ref counts as still open (an IPC channel for a fork, a ref'd
 * parentPort listener for a thread).
 */
export function setupChildProcess (scope: ForkScope, parent: ParentChannel, start: { argv: readonly string[], env: Readonly<Record<string, string>>, cwd: string, orivon: MessagePort }): ChildProcessSetup {
  // The runtime installed these before its polyfills loaded (early-globals.ts); a test scope has none yet.
  if (scope.process === undefined) installGlobals({ root: VIRTUAL_ROOT, tmpdir: VIRTUAL_TMPDIR }, scope)
  const proc = scope.process as BaseProcess
  let exited = false
  const liveness: Liveness = new Liveness(() => {
    if (exited) return
    const code = proc.exitCode ?? 0
    proc.emit('beforeExit', code)
    if (!liveness.idle) return
    proc.emit('exit', code)
    end(code)
  }, (run) => { later(run) })
  const later = trackScope(scope as Parameters<typeof trackScope>[0], liveness)
  scope.orivon = createOrivonClient(start.orivon, liveness)
  scope.Buffer = Buffer

  const end = (code: number | null, signal: string | null = null): void => {
    if (exited) return
    exited = true
    parent.post({ type: 'exit', code, signal })
    scope.close()
  }
  const write = (stream: StreamName) => (chunk: unknown, encodingOrCallback?: unknown, callback?: unknown): boolean => {
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk as ArrayBufferLike)
    parent.post({ type: 'output', stream, data: bytes.slice() })
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    if (typeof done === 'function') queueMicrotask(done as () => void)
    return true
  }

  proc.argv = [...start.argv]
  proc.env = { ...start.env }
  proc.cwd = () => start.cwd
  proc.stdout.write = write('stdout') as typeof proc.stdout.write
  proc.stderr.write = write('stderr') as typeof proc.stderr.write
  proc.stdin = new Readable({ read () {} })
  proc.exit = ((code?: number) => {
    if (code !== undefined) proc.exitCode = code
    proc.emit('exit', proc.exitCode ?? 0)
    end(proc.exitCode ?? 0)
    throw new ChildExit()
  }) as typeof proc.exit

  const crash = (error: unknown): void => {
    if (error instanceof ChildExit || exited) return
    if (proc.emit('uncaughtException', error, 'uncaughtException')) return
    // Raw, not a WireError: a worker_threads.Worker relays this as its own 'error' event (child.ts's 'crash'); fork has no listener for it.
    parent.post({ type: 'crash', error })
    write('stderr')(`${String((error as Error)?.stack ?? error)}\n`)
    end(1)
  }
  scope.addEventListener('error', (event) => { event.preventDefault(); crash((event as ErrorEvent).error) })
  scope.addEventListener('unhandledrejection', (event) => { event.preventDefault(); crash((event as PromiseRejectionEvent).reason) })

  return { proc, liveness, write, end, crash }
}

export async function runFork (start: ForkStart, parent: ParentChannel, scope: ForkScope, load: (url: string) => Promise<unknown>): Promise<void> {
  const { proc: baseProc, liveness, crash } = setupChildProcess(scope, parent, start)
  const proc = baseProc as ForkProcess
  // The IPC channel itself is a reason to stay alive, released only when it closes (closeChannel below).
  liveness.ref()
  ;(scope as unknown as Record<symbol, Liveness>)[FORK_LIVENESS_SYMBOL] = liveness
  proc.connected = true
  proc.send = (message: unknown, ...rest: unknown[]): boolean => {
    const callback = rest.find((arg): arg is SendCallback => typeof arg === 'function')
    if (!proc.connected) {
      const error = Object.assign(new Error('Channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' })
      if (callback === undefined) queueMicrotask(() => proc.emit('error', error))
      else queueMicrotask(() => callback(error))
      return false
    }
    parent.post({ type: 'ipc', message: serialize(message, start.serialization) })
    if (callback !== undefined) queueMicrotask(() => callback(null))
    return true
  }
  const closeChannel = (): void => {
    if (!proc.connected) return
    proc.connected = false
    queueMicrotask(() => { proc.emit('disconnect'); liveness.unref() })
  }
  proc.disconnect = () => {
    if (!proc.connected) return
    parent.post({ type: 'disconnect' })
    closeChannel()
  }

  const deliver = (message: ToWorker): void => {
    if (message.type === 'ipc') proc.emit('message', message.message)
    else if (message.type === 'stdin') proc.stdin.push(Buffer.from(message.data))
    else if (message.type === 'stdin-end') proc.stdin.push(null)
    else if (message.type === 'disconnect') closeChannel()
  }
  // Held until the module has run, or until it listens for 'message', which a
  // module with top-level await may do before its import settles: in Node a
  // child's top level runs before any IPC message is processed.
  let held: ToWorker[] | undefined = []
  const release = (): void => {
    const early = held
    held = undefined
    for (const message of early ?? []) deliver(message)
  }
  parent.onMessage((message) => { if (held === undefined) deliver(message); else held.push(message) })
  for (const method of ['on', 'addListener', 'once', 'prependListener'] as const) {
    const register = (proc as unknown as Record<string, unknown>)[method] as ((event: string, listener: (...args: unknown[]) => void) => unknown) | undefined
    if (register === undefined) continue
    ;(proc as unknown as Record<string, unknown>)[method] = (event: string, listener: (...args: unknown[]) => void) => {
      const result = register.call(proc, event, listener)
      if (event === 'message' && held !== undefined) queueMicrotask(release)
      return result
    }
  }

  parent.post({ type: 'started' })
  liveness.ref()
  try {
    await load(start.url)
  } catch (error) {
    crash(error)
  }
  release()
  liveness.unref()
}

