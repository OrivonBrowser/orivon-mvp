// Node's ChildProcess, over a Worker (../worker/). Output a program writes
// reaches `stdout`/`stderr` as Buffers; the Worker sends its next chunk only
// once the page has taken this one, so an unread stream pauses the program.
// `kill()` terminates the Worker, which is a real kill, and closes every
// handle it held.

import { Buffer } from 'buffer'
import { EventEmitter } from 'events'
import { Readable, Writable } from 'stream'
import { codedError } from '../node-errors.js'
import { lineSink } from '../wasi/stdio.js'
import type { OrivonServer } from '../worker/orivon-server.js'
import type { FromWorker, StreamName, ToWorker } from '../worker/protocol.js'

export type StdioMode = 'pipe' | 'ignore' | 'inherit'

export interface ChildOptions {
  readonly spawnfile: string
  readonly spawnargs: readonly string[]
  readonly stdio: readonly [StdioMode, StdioMode, StdioMode]
  readonly ipc: boolean
  readonly serialization: 'json' | 'advanced'
}

const SIGNALS: Readonly<Record<number, string>> = { 1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 6: 'SIGABRT', 9: 'SIGKILL', 15: 'SIGTERM' }

let nextPid = 2

function signalName (signal: string | number | undefined): string {
  if (signal === undefined) return 'SIGTERM'
  if (typeof signal === 'number') {
    const name = SIGNALS[signal]
    if (name === undefined) throw codedError(TypeError, 'ERR_UNKNOWN_SIGNAL', `Unknown signal: ${signal}`)
    return name
  }
  if (!/^SIG[A-Z0-9]+$/.test(signal)) throw codedError(TypeError, 'ERR_UNKNOWN_SIGNAL', `Unknown signal: ${signal}`)
  return signal
}

class OutputStream extends Readable {
  #ack: (() => void) | undefined

  constructor () {
    super({ autoDestroy: true, emitClose: true })
  }

  deliver (data: Uint8Array, ack: () => void): void {
    if (this.push(Buffer.from(data))) ack()
    else this.#ack = ack
  }

  override _read (): void {
    const ack = this.#ack
    this.#ack = undefined
    ack?.()
  }
}

export class ChildProcess extends EventEmitter {
  pid: number | undefined
  readonly spawnfile: string
  readonly spawnargs: readonly string[]
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  readonly stdio: Array<Readable | Writable | null>
  exitCode: number | null = null
  signalCode: string | null = null
  killed = false
  connected: boolean
  readonly #options: ChildOptions
  #worker: Worker | undefined
  #server: OrivonServer | undefined
  #queued: ToWorker[] = []
  #ended = false
  #killing = false
  #started = false
  readonly #inherit: Record<StreamName, ReturnType<typeof lineSink>>

  constructor (options: ChildOptions) {
    super()
    this.#options = options
    this.spawnfile = options.spawnfile
    this.spawnargs = options.spawnargs
    this.connected = options.ipc
    const [stdinMode, stdoutMode, stderrMode] = options.stdio
    this.stdin = stdinMode === 'pipe' ? this.#stdinStream() : null
    this.stdout = stdoutMode === 'pipe' ? new OutputStream() : null
    this.stderr = stderrMode === 'pipe' ? new OutputStream() : null
    this.stdio = [this.stdin, this.stdout, this.stderr]
    this.#inherit = { stdout: lineSink((line) => console.log(line)), stderr: lineSink((line) => console.error(line)) }
  }

  /** The Worker is running the child: flush what was written before it existed. */
  attach (worker: Worker, server: OrivonServer): void {
    this.#worker = worker
    this.#server = server
    this.pid = nextPid++
    worker.onmessage = (event: MessageEvent<FromWorker>) => { this.#receive(event.data) }
    worker.onerror = (event) => {
      event.preventDefault()
      // Before 'started', the Worker never ran the child: a spawn failure, with its reason.
      if (!this.#started) {
        this.emit('error', Object.assign(new Error(`the child's Worker failed to start: ${event.message}`), { code: 'ENOEXEC' }))
        this.#finish(-8, null, false)
      } else this.#finish(null, 'SIGABRT')
    }
    for (const message of this.#queued) worker.postMessage(message)
    this.#queued = []
  }

  /** The child never started: Node's order is 'error', then 'close'. */
  fail (error: Error): void {
    queueMicrotask(() => {
      if (this.#ended) return
      this.emit('error', error)
      this.#finish((error as { errno?: number }).errno ?? -1, null, false)
    })
  }

  /** Stops the child now; 'exit' follows asynchronously, as it does in Node. */
  kill (signal?: string | number): boolean {
    if (signal === 0) return !this.#ended && !this.#killing
    const name = signalName(signal)
    if (this.#ended || this.#killing) return false
    this.#killing = true
    this.killed = true
    this.#worker?.terminate()
    queueMicrotask(() => { this.#finish(null, name) })
    return true
  }

  /** True once the child has ended or is being killed: nothing more should start it. */
  get stopped (): boolean { return this.#ended || this.#killing }

  send (message: unknown, ...rest: unknown[]): boolean {
    const callback = rest.find((arg): arg is (error: Error | null) => void => typeof arg === 'function')
    if (!this.#options.ipc) throw codedError(Error, 'ERR_IPC_CHANNEL_CLOSED', 'Channel closed')
    if (!this.connected) {
      const error = codedError(Error, 'ERR_IPC_CHANNEL_CLOSED', 'Channel closed')
      queueMicrotask(() => { if (callback === undefined) this.emit('error', error); else callback(error) })
      return false
    }
    const payload = this.#options.serialization === 'json' ? JSON.parse(JSON.stringify(message) ?? 'null') as unknown : message
    this.#post({ type: 'ipc', message: payload })
    if (callback !== undefined) queueMicrotask(() => { callback(null) })
    return true
  }

  disconnect (): void {
    if (!this.connected) throw codedError(Error, 'ERR_IPC_DISCONNECTED', 'IPC channel is already disconnected')
    this.connected = false
    this.#post({ type: 'disconnect' })
    queueMicrotask(() => this.emit('disconnect'))
  }

  ref (): void {}
  unref (): void {}

  #post (message: ToWorker): void {
    if (this.#worker === undefined) this.#queued.push(message)
    else this.#worker.postMessage(message)
  }

  #stdinStream (): Writable {
    return new Writable({
      autoDestroy: true,
      emitClose: true,
      write: (chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void) => {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk
        this.#post({ type: 'stdin', data: new Uint8Array(bytes) })
        callback()
      },
      final: (callback: (error?: Error | null) => void) => { this.#post({ type: 'stdin-end' }); callback() }
    })
  }

  #receive (message: FromWorker): void {
    if (message.type === 'started') { this.#started = true; this.emit('spawn') }
    else if (message.type === 'output') this.#output(message.stream, message.data)
    else if (message.type === 'ipc') this.emit('message', message.message)
    // No child_process listener names this: it exists so worker_threads.Worker (thread.ts), which wraps a ChildProcess, can relay an uncaught error as its own 'error' event.
    else if (message.type === 'crash') this.emit('crash', message.error)
    else if (message.type === 'disconnect' && this.connected) { this.connected = false; this.emit('disconnect') }
    else if (message.type === 'failed') {
      this.emit('error', Object.assign(new Error(message.error.message), { code: message.error.code ?? 'ENOEXEC' }))
      this.#finish(-8, null, false)
    } else if (message.type === 'exit') this.#finish(message.code, message.signal, true)
  }

  #output (stream: StreamName, data: Uint8Array): void {
    const ack = (): void => { this.#post({ type: 'ack', stream }) }
    const target = stream === 'stdout' ? this.stdout : this.stderr
    const mode = this.#options.stdio[stream === 'stdout' ? 1 : 2]
    if (target instanceof OutputStream) { target.deliver(data, ack); return }
    if (mode === 'inherit') void this.#inherit[stream].sink(data)
    ack()
  }

  /** Records the end once: 'exit', then 'close' when every stdio stream has closed. */
  #finish (code: number | null, signal: string | null, emitExit = true): void {
    if (this.#ended) return
    this.#ended = true
    this.exitCode = code
    this.signalCode = signal
    if (this.connected) { this.connected = false; queueMicrotask(() => this.emit('disconnect')) }
    this.#worker?.terminate()
    void this.#server?.dispose()
    this.#inherit.stdout.flush()
    this.#inherit.stderr.flush()
    if (emitExit) this.emit('exit', code, signal)
    const outputs = [this.stdout, this.stderr].filter((stream): stream is Readable => stream !== null)
    let open = outputs.length
    const closed = (): void => { if (--open === 0) this.emit('close', code, signal) }
    if (open === 0) queueMicrotask(() => this.emit('close', code, signal))
    for (const stream of outputs) {
      stream.once('close', closed)
      stream.push(null)
      // As Node's flushStdio: a stream nobody reads is drained, so 'close' still fires.
      if (stream.listenerCount('data') === 0 && stream.listenerCount('readable') === 0) stream.resume()
    }
    this.stdin?.destroy()
  }
}
