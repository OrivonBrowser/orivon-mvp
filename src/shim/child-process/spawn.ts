// `spawn`: a WebAssembly program from the app's bundle, run in a Worker over
// the WASI host (../wasi/), its files the app's own through orivon.fs. Also
// the option handling and the Worker launch `fork` shares.

import { toConfinedPath } from '../fs/paths.js'
import { refuseShim } from '../errors.js'
import { abortError, codedError } from '../node-errors.js'
import { getOrivon } from '../orivon-global.js'
import { VIRTUAL_ROOT } from '../virtual-root.js'
import { createChildWorker } from '../worker/launch.js'
import { serveOrivon } from '../worker/orivon-server.js'
import type { ToWorker } from '../worker/protocol.js'
import { ChildProcess, type StdioMode } from './child.js'
import { loadProgram, spawnError } from './program.js'

export type StdioOption = StdioMode | 'ipc' | 'overlapped' | null | undefined

export interface SpawnOptions {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly argv0?: string
  readonly stdio?: StdioMode | 'overlapped' | readonly StdioOption[]
  readonly shell?: boolean | string
  readonly signal?: AbortSignal
  readonly timeout?: number
  readonly killSignal?: string | number
  readonly uid?: number
  readonly gid?: number
  readonly detached?: boolean
  readonly windowsHide?: boolean
  readonly windowsVerbatimArguments?: boolean
}

function invalidArg (name: string, expected: string, value: unknown): TypeError {
  return codedError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "${name}" argument must be ${expected}. Received ${typeof value}`)
}

/** Node's stdio forms, to three modes plus whether an IPC channel was asked for. */
export function normalizeStdio (stdio: SpawnOptions['stdio'], api: string): { modes: [StdioMode, StdioMode, StdioMode], ipc: boolean } {
  const list: readonly StdioOption[] = stdio === undefined ? [] : typeof stdio === 'string' ? [stdio, stdio, stdio] : stdio
  const ipc = list.includes('ipc')
  const mode = (index: number): StdioMode => {
    const entry = list[index]
    if (entry === undefined || entry === null || entry === 'overlapped') return 'pipe'
    if (entry === 'pipe' || entry === 'ignore' || entry === 'inherit') return entry
    if (entry === 'ipc') return 'ignore'
    throw refuseShim(`${api} options.stdio`, 'not-applicable', 'a file descriptor or a stream as a child\'s stdio names something only a real process has; use \'pipe\'')
  }
  return { modes: [mode(0), mode(1), mode(2)], ipc }
}

/** The environment a child gets: `env` as given, or the page's process.env. */
export function environmentOf (env: SpawnOptions['env']): Record<string, string> {
  const source = env ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
  return Object.fromEntries(Object.entries(source).flatMap(([key, value]) => value === undefined ? [] : [[key, String(value)]]))
}

/** `signal` and `timeout`, which end a child the same way `kill()` does. */
export function applyLifetime (child: ChildProcess, options: SpawnOptions): void {
  const killSignal = options.killSignal ?? 'SIGTERM'
  if (options.signal !== undefined) {
    const abort = (): void => {
      if (child.kill(killSignal)) child.emit('error', abortError(options.signal?.reason))
    }
    if (options.signal.aborted) queueMicrotask(abort)
    else options.signal.addEventListener('abort', abort, { once: true })
  }
  if (options.timeout !== undefined && options.timeout > 0) {
    const timer = setTimeout(() => child.kill(killSignal), options.timeout)
    child.once('exit', () => clearTimeout(timer))
  }
}

/** Starts the Worker. The start message goes first, then whatever was written to the child meanwhile. */
export function launch (child: ChildProcess, name: string, start: (orivon: MessagePort) => ToWorker): void {
  const worker = createChildWorker(name)
  const channel = new MessageChannel()
  const server = serveOrivon(channel.port1, getOrivon())
  worker.postMessage(start(channel.port2), [channel.port2])
  child.attach(worker, server)
}

function preopensFor (cwd: string | undefined): Record<string, string> {
  const dir = cwd ?? VIRTUAL_ROOT
  toConfinedPath(dir, 'spawn')
  return { '/': VIRTUAL_ROOT, '.': dir }
}

async function start (child: ChildProcess, command: string, args: readonly string[], options: SpawnOptions): Promise<void> {
  let preopens: Record<string, string>
  try {
    preopens = preopensFor(options.cwd)
  } catch {
    child.fail(spawnError('ENOENT', command, args, `cwd ${options.cwd ?? ''} is outside the app's files`))
    return
  }
  let module: WebAssembly.Module
  try {
    module = await loadProgram(command, args)
  } catch (error) {
    child.fail(error as Error)
    return
  }
  if (child.exitCode !== null || child.signalCode !== null) return
  const env = environmentOf(options.env)
  launch(child, `child_process ${command}`, (orivon) => ({ type: 'spawn', module, args: child.spawnargs, env, preopens, orivon }))
}

export function spawn (command: string, argsOrOptions?: readonly string[] | SpawnOptions, maybeOptions?: SpawnOptions): ChildProcess {
  if (typeof command !== 'string') throw invalidArg('file', 'of type string', command)
  if (command.length === 0) throw codedError(TypeError, 'ERR_INVALID_ARG_VALUE', "The argument 'file' cannot be empty. Received ''")
  const args = Array.isArray(argsOrOptions) ? argsOrOptions as readonly string[] : []
  const options: SpawnOptions = (Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions as SpawnOptions | undefined) ?? {}
  if (options.shell !== undefined && options.shell !== false) {
    throw refuseShim('child_process.spawn options.shell', 'not-applicable', 'an app has no shell: pass the program and its arguments directly')
  }
  if (options.uid !== undefined || options.gid !== undefined) {
    throw refuseShim('child_process.spawn options.uid', 'not-applicable', 'a child in an app tab has no operating-system user to run as')
  }
  const { modes, ipc } = normalizeStdio(options.stdio, 'child_process.spawn')
  if (ipc) throw refuseShim('child_process.spawn options.stdio', 'not-applicable', "'ipc' connects two Node processes; use fork for a JavaScript child")
  const child = new ChildProcess({ spawnfile: command, spawnargs: [options.argv0 ?? command, ...args.map(String)], stdio: modes, ipc: false, serialization: 'json' })
  applyLifetime(child, options)
  void start(child, command, args.map(String), options)
  return child
}
