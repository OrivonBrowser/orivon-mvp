// spawnSync/execSync/execFileSync's server-side half (child-process/index.ts
// is the Worker-side half): served where a Worker's orivon.* already is
// (spawn.ts's launch(), passed to worker/orivon-server.ts's serveOrivon as
// its runSpawnSync) -- the page, or a forked child serving its own nested
// thread. Runs the grandchild through the SAME spawn() every other child
// goes through, on THIS thread, asynchronously; only the Worker that asked
// blocks (over the sync channel), never this one (worker/README.md's rule).

import { Buffer } from 'buffer'
import { lineSink } from '../wasi/stdio.js'
import type { ChildProcess } from './child.js'
import type { SpawnOptions, StdioOption } from './spawn.js'

/** spawn.ts's own spawn(), passed in rather than imported: spawn.ts is this file's one caller (launch()'s own runSpawnSync closure), and importing spawn() here would cycle back to spawn.ts for no reason -- a type-only import does not. */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

/** `stdio` is the one option this shim can honour uniformly (README.md's own reasoning for a per-stream array is the async spawn's, not this synchronous family's) -- one of the three real modes spawn() already knows, or `undefined` for the default 'pipe'; anything else refuses by name on the client, before ever reaching here (child-process/index.ts's own `stdioModeOf`). */
export interface SpawnSyncRequest {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly env: Readonly<Record<string, string>>
  readonly timeout?: number
  readonly killSignal?: string | number
  readonly maxBuffer: number
  readonly input?: Uint8Array
  readonly stdio?: Exclude<StdioOption, 'overlapped' | 'ipc' | null | undefined>
  /** execSync/execFileSync's own default (unlike spawnSync's): the child's stderr also reaches the parent's stderr as it arrives, not just the wire result -- only meaningful with `stdio` left at its 'pipe' default. */
  readonly forwardStderr?: boolean
}

export interface SpawnSyncWireError {
  readonly name: string
  readonly message: string
  readonly code?: string
  readonly errno?: number
  readonly syscall?: string
  readonly path?: string
  readonly spawnargs?: readonly string[]
}

export interface SpawnSyncWireResult {
  readonly pid: number | undefined
  /** `null`, not empty bytes, for a child whose `stdio` was not 'pipe' -- Node reports no captured output the same way. */
  readonly stdout: Uint8Array | null
  readonly stderr: Uint8Array | null
  readonly status: number | null
  readonly signal: string | null
  readonly error?: SpawnSyncWireError
}

/**
 * A spawn-shaped error's own message and `syscall` both start with `spawn
 * <file>` (program.ts's `spawnError`, shared with the async `spawn()`) --
 * `spawnSync` names itself `spawnSync <file>` instead, the one real
 * difference Node draws between the two callers of the same failure
 * (measured). The maxBuffer/timeout errors below are already worded this
 * way, so this only ever touches a spawn failure passed through unchanged.
 */
function asSpawnSyncWording (text: string): string {
  return text.startsWith('spawn ') ? `spawnSync ${text.slice('spawn '.length)}` : text
}

/** Every field Node puts on a `spawnSync` failure it has, carried onto the wire instead of only `name`/`message`/`code` -- `errno`/`syscall`/`path`/`spawnargs` matter to a caller that inspects `result.error` (child-process/index.ts's own `finishOrThrow` puts them back on the thrown error). */
function wireErrorOf (error: unknown): SpawnSyncWireError {
  const named = error as {
    name?: unknown, message?: unknown, code?: unknown, errno?: unknown, syscall?: unknown, path?: unknown, spawnargs?: unknown
  }
  const message = typeof named.message === 'string' ? asSpawnSyncWording(named.message) : String(error)
  return {
    name: typeof named.name === 'string' ? named.name : 'Error',
    message,
    ...(typeof named.code === 'string' ? { code: named.code } : {}),
    ...(typeof named.errno === 'number' ? { errno: named.errno } : {}),
    ...(typeof named.syscall === 'string' ? { syscall: asSpawnSyncWording(named.syscall) } : {}),
    ...(typeof named.path === 'string' ? { path: named.path } : {}),
    ...(Array.isArray(named.spawnargs) ? { spawnargs: named.spawnargs.map(String) } : {})
  }
}

/** Node's own wording for spawnSync's maxBuffer overflow -- ENOBUFS, with its own errno/syscall (measured), distinct from exec's own ERR_CHILD_PROCESS_STDIO_MAXBUFFER (exec.ts's collect()). */
function maxBufferError (command: string): Error & { code: string, errno: number, syscall: string } {
  return Object.assign(new Error(`spawnSync ${command} ENOBUFS`), { code: 'ENOBUFS', errno: -105, syscall: `spawnSync ${command}` })
}

/** Node's own wording for spawnSync's timeout kill -- ETIMEDOUT, with its own errno/syscall (measured). */
function timeoutError (command: string): Error & { code: string, errno: number, syscall: string } {
  return Object.assign(new Error(`spawnSync ${command} ETIMEDOUT`), { code: 'ETIMEDOUT', errno: -110, syscall: `spawnSync ${command}` })
}

export async function runSpawnSync (
  spawn: SpawnFn, request: SpawnSyncRequest, registerChild?: (kill: () => void) => void
): Promise<SpawnSyncWireResult> {
  const stdio = request.stdio ?? 'pipe'
  const options: SpawnOptions = {
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    env: request.env,
    stdio,
    ...(request.killSignal === undefined ? {} : { killSignal: request.killSignal })
  }
  let child: ChildProcess
  try {
    child = spawn(request.command, [...request.args], options)
  } catch (error) {
    return { pid: undefined, stdout: null, stderr: null, status: null, signal: null, error: wireErrorOf(error) }
  }
  // The Worker blocked on this call has no handle of its own to this
  // grandchild -- only orivon-server.ts's serveOrivon does, through this,
  // so a Worker killed mid-spawnSync does not leave it running forever
  // (finding 20).
  registerChild?.(() => { child.kill(request.killSignal) })

  const chunks: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] }
  // Node counts stdout and stderr TOGETHER against one maxBuffer, and keeps
  // the chunk that crosses it (only the NEXT chunk is refused) -- measured
  // against Node's own spawnSync, 3000+3000 bytes over a 4000 limit.
  let combinedSize = 0
  let bufferFailure: (Error & { code: string }) | undefined
  let timeoutFailure: (Error & { code: string }) | undefined
  // execSync/execFileSync's own default: the child's stderr also reaches
  // the parent's stderr as it streams, not only the captured result --
  // line-buffered the same way child.ts's own 'inherit' mode is.
  const stderrSink = request.forwardStderr === true && stdio === 'pipe' ? lineSink((line) => console.error(line)) : undefined
  for (const name of ['stdout', 'stderr'] as const) {
    child[name]?.on('data', (chunk: Buffer) => {
      if (bufferFailure !== undefined || timeoutFailure !== undefined) return
      chunks[name].push(chunk)
      combinedSize += chunk.length
      if (name === 'stderr') stderrSink?.sink(chunk)
      if (combinedSize > request.maxBuffer) {
        bufferFailure = maxBufferError(request.command)
        child.kill(request.killSignal)
      }
    })
  }

  if (request.input !== undefined) child.stdin?.end(Buffer.from(request.input))
  else child.stdin?.end()

  // Armed here, not left to spawn()'s own `applyLifetime` (which only kills
  // the child): the caller needs to learn a kill was a TIMEOUT, over ordinary
  // exit or a signal from elsewhere -- `options` above deliberately drops
  // `request.timeout`, so this is the child's only timer.
  let timer: ReturnType<typeof setTimeout> | undefined
  if (request.timeout !== undefined && request.timeout > 0) {
    timer = setTimeout(() => {
      timeoutFailure = timeoutError(request.command)
      child.kill(request.killSignal)
    }, request.timeout)
  }

  let spawnFailure: Error | undefined
  return await new Promise((resolve) => {
    // 'close' always follows, whether the child ran and exited/was killed or
    // never started at all (child.ts's own fail()/#finish() guarantee this),
    // so resolving there alone sees every outcome exactly once. Its own
    // code/signal already reflect a maxBuffer or timeout kill correctly --
    // no need to recompute either here.
    child.once('error', (error: Error) => { spawnFailure = error })
    child.once('close', (code: number | null, signal: string | null) => {
      if (timer !== undefined) clearTimeout(timer)
      stderrSink?.flush()
      const failure = spawnFailure ?? timeoutFailure ?? bufferFailure
      resolve({
        pid: child.pid,
        stdout: stdio === 'pipe' ? new Uint8Array(Buffer.concat(chunks.stdout)) : null,
        stderr: stdio === 'pipe' ? new Uint8Array(Buffer.concat(chunks.stderr)) : null,
        status: failure === undefined ? code : null,
        signal,
        ...(failure === undefined ? {} : { error: wireErrorOf(failure) })
      })
    })
  })
}
