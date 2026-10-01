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
import type { HostStart } from '../worker/host-protocol.js'
import { ChildProcess, type StdioMode } from './child.js'
import { loadProgram, spawnError } from './program.js'
import { createRemoteWorker, hasChildHost } from './host-client.js'
import { runSpawnSync, type SpawnSyncRequest } from './spawn-sync.js'

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

/**
 * `command`'s own two argument errors, real Node's own (measured) for
 * `spawn`, `spawnSync` and `execFileSync` alike. Exported so
 * child-process/index.ts's `spawnSyncCore` can throw these synchronously,
 * on the calling thread, before ever building the sync-channel request --
 * a bad argument caught only inside `spawn-sync.ts`'s `runSpawnSync` (over
 * on the OTHER side of that channel) would come back as `result.error`
 * instead, since nothing there can throw back onto this thread's own stack.
 */
export function validateCommand (command: unknown): asserts command is string {
  if (typeof command !== 'string') throw invalidArg('file', 'of type string', command)
  if (command.length === 0) throw codedError(TypeError, 'ERR_INVALID_ARG_VALUE', "The argument 'file' cannot be empty. Received ''")
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

/**
 * Starts the child: through an app's own child host if one exists for this
 * page (ADR-0046), or a same-process Worker otherwise -- `ChildProcess`
 * itself never knows which (`child.attach()` takes a `WorkerLike` either
 * way). `hasChildHost()` (F1/W7) is a plain structural check -- the
 * preload's bridge either exists on this document already or it never
 * will -- so there is nothing left to await or time out on before choosing
 * a path.
 *
 * `hostStart` is what a host-routed child sends across the extra hop --
 * never a precompiled program, which does not survive it (ADR-0046's
 * Context). `localStart` builds the real start message for a same-process
 * Worker, and may do async work a host-routed child skips entirely (a
 * spawn's own program compile, moved to the host instead).
 * `extraTransfer` carries a thread's own `parentPort` and any
 * `transferList` the app asked for on the LOCAL path only; spawn and fork
 * pass none, and a host-routed child never carries one (only a thread ever
 * needed it, and a thread never routes through the host -- ADR-0046's
 * Decision). `viaHost` lets a caller that must never route through the
 * host (a thread) say so; every other caller takes the default.
 */
export async function launchChild (
  child: ChildProcess,
  name: string,
  hostStart: HostStart,
  localStart: () => Promise<Omit<ToWorker, 'orivon'>> | Omit<ToWorker, 'orivon'>,
  extraTransfer: readonly Transferable[] = [],
  viaHost = true
): Promise<void> {
  if (child.stopped) return
  if (viaHost && hasChildHost()) {
    child.attach(createRemoteWorker(hostStart), { dispose: async () => {} })
    return
  }

  let base: Omit<ToWorker, 'orivon'>
  try {
    base = await localStart()
  } catch (error) {
    child.fail(error as Error)
    return
  }
  if (child.stopped) return

  let worker: Worker
  let server: ReturnType<typeof serveOrivon>
  const channel = new MessageChannel()
  try {
    worker = createChildWorker(name)
    // A Worker's own spawnSync/execSync/execFileSync (SPAWN_SYNC,
    // worker/sync-channel.ts): served on THIS thread, over the SAME spawn()
    // every other child goes through -- never a synchronous call from the
    // thread that serves it (worker/README.md's rule; only the Worker that
    // asked blocks, over the sync channel).
    server = serveOrivon(
      channel.port1, getOrivon(),
      async (payload, registerChild) => await runSpawnSync(spawn, payload as SpawnSyncRequest, registerChild)
    )
  } catch (error) {
    // A page whose CSP refuses the Worker, or that has no orivon: a spawn failure, reported as one.
    child.fail(Object.assign(new Error(`the child cannot start: ${String((error as Error)?.message ?? error)}`), { code: 'ENOEXEC', errno: -8 }))
    return
  }
  try {
    worker.postMessage({ ...base, orivon: channel.port2 } as ToWorker, [channel.port2, ...extraTransfer])
  } catch (error) {
    // Neither leaked: nothing else will ever terminate this Worker or dispose this server once
    // `child.fail()` has already reported the start as never having happened.
    worker.terminate()
    void server.dispose()
    child.fail(error as Error)
    return
  }
  child.attach(worker, server)
}

/**
 * The app's files are the program's `/`, and also `VIRTUAL_ROOT` itself: a program is handed paths in the
 * form the app's own code holds (`/orivon/app/...`), and the runtime picks the longest matching preopen.
 */
export function preopensFor (cwd: string | undefined): Record<string, string> {
  const dir = cwd ?? VIRTUAL_ROOT
  toConfinedPath(dir, 'spawn')
  return { '/': VIRTUAL_ROOT, [VIRTUAL_ROOT]: VIRTUAL_ROOT, '.': dir }
}

async function start (child: ChildProcess, command: string, args: readonly string[], options: SpawnOptions): Promise<void> {
  let preopens: Record<string, string>
  try {
    preopens = preopensFor(options.cwd)
  } catch {
    child.fail(spawnError('ENOENT', command, args, `cwd ${options.cwd ?? ''} is outside the app's files`))
    return
  }
  const env = environmentOf(options.env)
  await launchChild(
    child,
    `child_process ${command}`,
    { type: 'spawn', command, args: child.spawnargs, env, preopens },
    async () => ({ type: 'spawn', program: await loadProgram(command, args), args: child.spawnargs, env, preopens })
  )
}

export function spawn (command: string, argsOrOptions?: readonly string[] | SpawnOptions, maybeOptions?: SpawnOptions): ChildProcess {
  validateCommand(command)
  const args = Array.isArray(argsOrOptions) ? argsOrOptions as readonly string[] : []
  const options: SpawnOptions = (Array.isArray(argsOrOptions) || argsOrOptions === undefined || argsOrOptions === null ? maybeOptions : argsOrOptions as SpawnOptions) ?? {}
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
