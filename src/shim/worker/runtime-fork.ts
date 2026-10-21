// Inside the Worker: gives an app module the Node process a forked child
// has (argv, env, send/'message', disconnect, exit, stdio) and the same
// shim globals and orivon an app tab has, then imports it. setupChildProcess
// is the part a thread needs too (runtime-thread.ts): argv/env/cwd, output
// posting, process.exit ending only the child, and uncaught-error handling.
// IPC (send/connected/disconnect) is fork-only, since a thread has none.

import { Buffer } from 'buffer'
import { Readable } from 'stream'
import { installGlobals } from '../globals.js'
import { Console } from '../polyfills/console-class.js'
import { createRequire } from '../polyfills/module.js'
import type { GlobalsTarget, ShimProcess } from '../globals-types.js'
import { NODE_IDENTITY } from '../node-identity.js'
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
  require?: unknown
  console?: Record<string, unknown>
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
export function setupChildProcess (scope: ForkScope, parent: ParentChannel, start: { type: 'fork' | 'thread', argv: readonly string[], env: Readonly<Record<string, string>>, cwd: string, orivon: MessagePort }): ChildProcessSetup {
  // The runtime installed these before its polyfills loaded (early-globals.ts); a test scope has none yet.
  if (scope.process === undefined) installGlobals({ root: VIRTUAL_ROOT, tmpdir: VIRTUAL_TMPDIR, node: NODE_IDENTITY }, scope)
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
  // esbuild's `__require` helper reads a global `require` when its call runs; the module
  // set-up runs before any of the app's code, so a bundle's dynamic require finds this one.
  if (scope.require === undefined) {
    Object.defineProperty(scope, 'require', { value: createRequire(`${start.cwd}/`), configurable: true, writable: true })
  }

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
    if (start.type === 'thread') {
      // Raw, not a WireError: a worker_threads.Worker relays this as its own 'error' event
      // (child.ts's 'crash'). Node prints nothing to stderr for a thread's own uncaught error,
      // only the 'error' event, so there is no write('stderr') on this branch.
      try {
        parent.post({ type: 'crash', error })
      } catch {
        // Not every thrown value survives structured clone (a non-cloneable `cause`, a thrown
        // Symbol, a rejected Event, ...); fall back to one that does, so the app still gets an
        // 'error' event instead of losing the crash path to a second, unhandled error.
        parent.post({ type: 'crash', error: new Error(String((error as { message?: unknown } | null)?.message ?? error)) })
      }
    } else {
      // A fork has no listener for 'crash': Node prints an uncaught exception's stack to a
      // forked child's stderr, which this reproduces.
      write('stderr')(`${String((error as Error)?.stack ?? error)}\n`)
    }
    end(1)
  }
  scope.addEventListener('error', (event) => { event.preventDefault(); crash((event as ErrorEvent).error) })
  scope.addEventListener('unhandledrejection', (event) => { event.preventDefault(); crash((event as PromiseRejectionEvent).reason) })

  return { proc, liveness, write, end, crash }
}

const CONSOLE_METHODS = ['log', 'info', 'debug', 'dirxml', 'warn', 'error', 'trace', 'dir', 'table', 'assert', 'count', 'countReset', 'group', 'groupCollapsed', 'groupEnd', 'time', 'timeEnd', 'timeLog'] as const

/**
 * A forked child's console is a `Console` over its `process.stdout` and `process.stderr`, as
 * Node's is, so its output reaches `child.stdout` and a program that patches either `write`
 * sees it. The Worker's own console still gets every call too, so a developer's devtools keep
 * showing them.
 */
function routeConsole (target: Record<string, unknown> | undefined, proc: BaseProcess): void {
  if (target === undefined) return
  const streams = {
    stdout: { write: (chunk: string, callback?: () => void) => proc.stdout.write(chunk, callback as never) },
    stderr: { write: (chunk: string, callback?: () => void) => proc.stderr.write(chunk, callback as never) }
  }
  const child = new Console(streams) as unknown as Record<string, (...args: unknown[]) => void>
  for (const name of CONSOLE_METHODS) {
    const original = target[name]
    target[name] = (...args: unknown[]): void => {
      if (typeof original === 'function') (original as (...rest: unknown[]) => void).apply(target, args)
      child[name]!(...args)
    }
  }
  target.Console ??= Console
}

export async function runFork (start: ForkStart, parent: ParentChannel, scope: ForkScope, load: (url: string) => Promise<unknown>): Promise<void> {
  const { proc: baseProc, liveness, crash } = setupChildProcess(scope, parent, start)
  routeConsole(scope.console, baseProc)
  const proc = baseProc as ForkProcess
  ;(scope as unknown as Record<symbol, Liveness>)[FORK_LIVENESS_SYMBOL] = liveness
  proc.connected = true
  // As in Node, the open channel keeps the child alive only while something listens on it: a 'message' or
  // 'disconnect' listener takes the reference and the last one going away (or the channel closing) gives it back.
  // The process object has no 'newListener' events, so each way a listener comes or goes re-reads the count.
  let channelRef = false
  const syncChannel = (): void => {
    const wanted = proc.connected && proc.listenerCount('message') + proc.listenerCount('disconnect') > 0
    if (wanted && !channelRef) { channelRef = true; liveness.ref() } else if (!wanted && channelRef) { channelRef = false; liveness.unref() }
  }
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
    queueMicrotask(() => { proc.emit('disconnect'); syncChannel() })
  }
  proc.disconnect = () => {
    if (!proc.connected) return
    parent.post({ type: 'disconnect' })
    closeChannel()
  }

  const deliver = (message: ToWorker): void => {
    if (message.type === 'ipc') { proc.emit('message', message.message); syncChannel() }
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
  for (const method of ['on', 'addListener', 'once', 'prependListener', 'off', 'removeListener', 'removeAllListeners'] as const) {
    const register = (proc as unknown as Record<string, unknown>)[method] as ((event: string, listener: (...args: unknown[]) => void) => unknown) | undefined
    if (register === undefined) continue
    ;(proc as unknown as Record<string, unknown>)[method] = (event: string, listener: (...args: unknown[]) => void) => {
      const result = register.call(proc, event, listener)
      if (event === 'message' && held !== undefined && !method.startsWith('remove') && method !== 'off') queueMicrotask(release)
      syncChannel()
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

