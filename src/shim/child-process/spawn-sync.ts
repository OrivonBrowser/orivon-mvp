// spawnSync/execSync/execFileSync's server-side half (child-process/index.ts
// is the Worker-side half): served where a Worker's orivon.* already is
// (spawn.ts's launch(), passed to worker/orivon-server.ts's serveOrivon as
// its runSpawnSync) -- the page, or a forked child serving its own nested
// thread. Runs the grandchild through the SAME spawn() every other child
// goes through, on THIS thread, asynchronously; only the Worker that asked
// blocks (over the sync channel), never this one (worker/README.md's rule).

import { Buffer } from 'buffer'
import type { ChildProcess } from './child.js'
import type { SpawnOptions } from './spawn.js'

/** spawn.ts's own spawn(), passed in rather than imported: spawn.ts is this file's one caller (launch()'s own runSpawnSync closure), and importing spawn() here would cycle back to spawn.ts for no reason -- a type-only import does not. */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export interface SpawnSyncRequest {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly env: Readonly<Record<string, string>>
  readonly timeout?: number
  readonly killSignal?: string | number
  readonly maxBuffer: number
  readonly input?: Uint8Array
}

export interface SpawnSyncWireError {
  readonly name: string
  readonly message: string
  readonly code?: string
}

export interface SpawnSyncWireResult {
  readonly pid: number | undefined
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
  readonly status: number | null
  readonly signal: string | null
  readonly error?: SpawnSyncWireError
}

function wireErrorOf (error: unknown): SpawnSyncWireError {
  const named = error as { name?: unknown, message?: unknown, code?: unknown }
  return {
    name: typeof named.name === 'string' ? named.name : 'Error',
    message: typeof named.message === 'string' ? named.message : String(error),
    ...(typeof named.code === 'string' ? { code: named.code } : {})
  }
}

/** Node's own wording for spawnSync's maxBuffer overflow -- ENOBUFS, distinct from exec's own ERR_CHILD_PROCESS_STDIO_MAXBUFFER (exec.ts's collect()). */
function maxBufferError (stream: 'stdout' | 'stderr', command: string): Error & { code: string } {
  return Object.assign(new Error(`${command} ENOBUFS`), { code: 'ENOBUFS', stream })
}

export async function runSpawnSync (spawn: SpawnFn, request: SpawnSyncRequest): Promise<SpawnSyncWireResult> {
  const options: SpawnOptions = {
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    env: request.env,
    stdio: 'pipe',
    ...(request.killSignal === undefined ? {} : { killSignal: request.killSignal }),
    ...(request.timeout === undefined ? {} : { timeout: request.timeout })
  }
  let child: ChildProcess
  try {
    child = spawn(request.command, [...request.args], options)
  } catch (error) {
    return { pid: undefined, stdout: new Uint8Array(0), stderr: new Uint8Array(0), status: null, signal: null, error: wireErrorOf(error) }
  }

  const chunks: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] }
  const size = { stdout: 0, stderr: 0 }
  let bufferError: (Error & { code: string }) | undefined
  for (const name of ['stdout', 'stderr'] as const) {
    child[name]?.on('data', (chunk: Buffer) => {
      if (bufferError !== undefined) return
      size[name] += chunk.length
      if (size[name] > request.maxBuffer) {
        bufferError = maxBufferError(name, request.command)
        child.kill(request.killSignal)
        return
      }
      chunks[name].push(chunk)
    })
  }

  if (request.input !== undefined) child.stdin?.end(Buffer.from(request.input))
  else child.stdin?.end()

  let spawnError: Error | undefined
  return await new Promise((resolve) => {
    // 'close' always follows, whether the child ran and exited/was killed or
    // never started at all (child.ts's own fail()/#finish() guarantee this),
    // so resolving there alone sees every outcome exactly once. Its own
    // code/signal already reflect a maxBuffer kill correctly -- no need to
    // recompute either here.
    child.once('error', (error: Error) => { spawnError = error })
    child.once('close', (code: number | null, signal: string | null) => {
      const failure = spawnError ?? bufferError
      resolve({
        pid: child.pid,
        stdout: new Uint8Array(Buffer.concat(chunks.stdout)),
        stderr: new Uint8Array(Buffer.concat(chunks.stderr)),
        status: failure === undefined ? code : null,
        signal,
        ...(failure === undefined ? {} : { error: wireErrorOf(failure) })
      })
    })
  })
}
