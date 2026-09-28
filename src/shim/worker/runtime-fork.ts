// Inside the Worker: gives an app module the Node process a forked child
// has (argv, env, send/'message', disconnect, exit, stdio) and the same
// shim globals and orivon an app tab has, then imports it.

import { Buffer } from 'buffer'
import { Readable } from 'stream'
import { installGlobals } from '../globals.js'
import type { GlobalsTarget, ShimProcess } from '../globals-types.js'
import { VIRTUAL_ROOT, VIRTUAL_TMPDIR } from '../virtual-root.js'
import { Liveness, trackScope } from './liveness.js'
import { createOrivonClient } from './orivon-client.js'
import type { ParentChannel } from './parent.js'
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
class ForkExit extends Error {}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

interface ForkProcess extends Mutable<ShimProcess> {
  connected: boolean
  stdin: Readable
  send (message: unknown, ...rest: unknown[]): boolean
  disconnect (): void
}

function serialize (message: unknown, serialization: ForkStart['serialization']): unknown {
  return serialization === 'json' ? JSON.parse(JSON.stringify(message) ?? 'null') : message
}

export async function runFork (start: ForkStart, parent: ParentChannel, scope: ForkScope, load: (url: string) => Promise<unknown>): Promise<void> {
  // The runtime installed these before its polyfills loaded (early-globals.ts); a test scope has none yet.
  if (scope.process === undefined) installGlobals({ root: VIRTUAL_ROOT, tmpdir: VIRTUAL_TMPDIR }, scope)
  const proc = scope.process as ForkProcess
  let exited = false
  // Node's rule for when a child ends on its own: nothing pending and the IPC channel closed.
  const liveness: Liveness = new Liveness(() => {
    if (exited) return
    const code = proc.exitCode ?? 0
    proc.emit('beforeExit', code)
    if (!liveness.idle) return
    proc.emit('exit', code)
    end(code)
  }, (run) => { later(run) })
  const later = trackScope(scope as Parameters<typeof trackScope>[0], liveness)
  liveness.ref()
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
  proc.connected = true
  proc.stdout.write = write('stdout') as typeof proc.stdout.write
  proc.stderr.write = write('stderr') as typeof proc.stderr.write
  proc.stdin = new Readable({ read () {} })
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
  proc.exit = ((code?: number) => {
    if (code !== undefined) proc.exitCode = code
    proc.emit('exit', proc.exitCode ?? 0)
    end(proc.exitCode ?? 0)
    throw new ForkExit()
  }) as typeof proc.exit

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

  // An uncaught error ends a Node child with code 1 and its stack on stderr.
  const crash = (error: unknown): void => {
    if (error instanceof ForkExit || exited) return
    if (proc.emit('uncaughtException', error, 'uncaughtException')) return
    write('stderr')(`${String((error as Error)?.stack ?? error)}\n`)
    end(1)
  }
  scope.addEventListener('error', (event) => { event.preventDefault(); crash((event as ErrorEvent).error) })
  scope.addEventListener('unhandledrejection', (event) => { event.preventDefault(); crash((event as PromiseRejectionEvent).reason) })

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

