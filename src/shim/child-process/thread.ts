// `worker_threads.Worker`: an app module run as a thread in the same Web
// Worker runtime child_process.fork uses (../worker/runtime-thread.ts),
// reusing ChildProcess and spawn.ts's launchChild() for the Worker lifecycle,
// its orivon.*, output backpressure and handle teardown on kill.
// parentPort traffic crosses on its own MessageChannel, never
// ChildProcess's control channel.

import { EventEmitter } from 'events'
import type { Readable, Writable } from 'stream'
import { refuseShim } from '../errors.js'
import { VIRTUAL_ROOT } from '../virtual-root.js'
import { createWarnOnce } from '../warn-once.js'
import { unwrapPorts, wrapPort } from '../worker/node-port.js'
import { FORK_LIVENESS_SYMBOL, WORKER_THREADS_SYMBOL } from '../worker/symbols.js'
import { ChildProcess } from './child.js'
import { moduleUrl } from './fork.js'
import { environmentOf, launchChild, type SpawnOptions } from './spawn.js'

const warnOnce = createWarnOnce('orivon worker_threads.Worker')
const SHARE_ENV = Symbol.for('nodejs.worker_threads.SHARE_ENV')

export interface WorkerOptions {
  readonly workerData?: unknown
  readonly transferList?: readonly unknown[]
  readonly stdin?: boolean
  readonly stdout?: boolean
  readonly stderr?: boolean
  readonly env?: SpawnOptions['env'] | typeof SHARE_ENV
  readonly argv?: readonly unknown[]
  readonly execArgv?: readonly string[]
  readonly resourceLimits?: Readonly<Record<string, unknown>>
  readonly eval?: boolean
  readonly name?: string
}

let nextThreadId = 1

/** A signal means the thread was killed (terminate(), or a revoked grant): Node reports that as exit code 1, never the signal itself, since worker_threads has no OS signals. */
function exitCodeOf (child: ChildProcess): number {
  return child.signalCode !== null ? 1 : (child.exitCode ?? 0)
}

export class Worker extends EventEmitter {
  readonly threadId: number
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  readonly resourceLimits: Readonly<Record<string, unknown>>
  readonly #child: ChildProcess
  readonly #port: ReturnType<typeof wrapPort>
  readonly #outerLiveness: { ref: () => void, unref: () => void } | undefined
  #refd = true
  #exitCode: number | undefined
  #exit: Promise<number | undefined> | undefined

  constructor (filename: string | URL, options: WorkerOptions = {}) {
    super()
    if (options.eval === true) {
      throw refuseShim('worker_threads.Worker', 'not-applicable', 'eval is not supported here: pass a module path, not a string of code to evaluate')
    }
    // Set only inside a running thread (runtime-thread.ts): a thread cannot start another.
    if ((globalThis as unknown as Record<symbol, unknown>)[WORKER_THREADS_SYMBOL] !== undefined) {
      throw refuseShim('worker_threads.Worker', 'not-applicable', 'a thread cannot start another thread: nested worker_threads.Worker is not supported')
    }
    if (options.execArgv !== undefined && options.execArgv.length > 0) {
      warnOnce('execArgv', 'a thread runs in a Web Worker, which takes no native runtime flags')
    }
    if (options.resourceLimits !== undefined) {
      warnOnce('resourceLimits', "a thread's memory and stack limits are not enforced")
    }
    let env: Record<string, string>
    if (options.env === SHARE_ENV) {
      warnOnce('env: SHARE_ENV', 'a thread runs in its own realm: it gets a copy of the environment, never one truly shared with its parent')
      env = environmentOf(undefined)
    } else {
      env = environmentOf(options.env as SpawnOptions['env'])
    }

    const origin = globalThis.location.origin
    const url = moduleUrl(filename, origin, 'worker_threads.Worker', 'a thread')
    const path = new URL(url).pathname
    const argv = ['node', path, ...(options.argv ?? []).map(String)]
    const name = options.name ?? `worker_threads ${path}`

    this.threadId = nextThreadId++
    this.resourceLimits = { ...options.resourceLimits }

    const child = new ChildProcess({ spawnfile: 'node', spawnargs: argv, stdio: ['pipe', 'pipe', 'pipe'], ipc: false, serialization: 'json' })
    this.#child = child
    child.once('spawn', () => { this.emit('online') })
    child.on('error', (error: unknown) => { this.emit('error', error) })
    child.on('crash', (error: unknown) => { this.emit('error', error) })
    child.once('exit', () => { this.#releaseOuterRef() })
    child.once('close', () => {
      this.#exitCode = exitCodeOf(child)
      this.emit('exit', this.#exitCode)
    })

    this.stdin = options.stdin === true ? child.stdin : null
    this.stdout = options.stdout === true ? child.stdout : null
    this.stderr = options.stderr === true ? child.stderr : null
    // Not exposed: read anyway (the ack backpressure needs a reader) and forward to this realm's own output, as Node pipes an unpiped stream to its parent's.
    const parentProcess = (globalThis as unknown as { process?: { stdout: { write: (chunk: unknown) => unknown }, stderr: { write: (chunk: unknown) => unknown } } }).process
    if (options.stdout !== true) child.stdout?.on('data', (chunk: Uint8Array) => { parentProcess?.stdout.write(chunk) })
    if (options.stderr !== true) child.stderr?.on('data', (chunk: Uint8Array) => { parentProcess?.stderr.write(chunk) })

    const portChannel = new MessageChannel()
    this.#port = wrapPort(portChannel.port1)
    this.#port.on('message', (value: unknown) => { this.emit('message', value) })
    this.#port.on('messageerror', (value: unknown) => { this.emit('messageerror', value) })

    // A ref'd Worker keeps a forked child alive, as a ref'd thread does in real Node; absent outside a fork, where nothing here ever exits on its own.
    this.#outerLiveness = (globalThis as unknown as Record<symbol, { ref: () => void, unref: () => void } | undefined>)[FORK_LIVENESS_SYMBOL]
    this.#outerLiveness?.ref()

    const transferList = (options.transferList ?? []).map(unwrapPorts) as Transferable[]
    const threadStart = {
      type: 'thread' as const,
      url,
      argv,
      env,
      cwd: VIRTUAL_ROOT,
      threadId: this.threadId,
      workerData: unwrapPorts(options.workerData),
      name,
      parentPort: portChannel.port2,
      stdin: options.stdin === true,
      stdout: options.stdout === true,
      stderr: options.stderr === true
    }
    void launchChild(child, name, threadStart, () => threadStart, [portChannel.port2, ...transferList])
  }

  postMessage (value: unknown, transferList?: readonly unknown[]): void {
    this.#port.postMessage(value, transferList)
  }

  /** Ends the thread now, as Node's does with code 1, whatever it was doing; resolves once it has, and with `undefined` for a thread that had already exited, as Node's does. */
  terminate (): Promise<number | undefined> {
    if (this.#exitCode !== undefined) return Promise.resolve(undefined)
    this.#exit ??= new Promise((resolve) => { this.once('exit', (code: number) => { resolve(code) }) })
    this.#child.kill()
    return this.#exit
  }

  ref (): void {
    if (this.#refd) return
    this.#refd = true
    this.#outerLiveness?.ref()
  }

  unref (): void {
    if (!this.#refd) return
    this.#releaseOuterRef()
  }

  #releaseOuterRef (): void {
    if (!this.#refd) return
    this.#refd = false
    this.#outerLiveness?.unref()
  }
}
