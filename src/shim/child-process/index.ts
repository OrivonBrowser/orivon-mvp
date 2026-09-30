// `child_process` module target (module-map.ts). A child is WebAssembly or
// JavaScript in a Worker, never an operating-system process (ADR-0040):
// `spawn` runs a WASI program from the app's bundle and `fork` an app
// module. `spawnSync`/`execSync`/`execFileSync` (ADR-0016's Worker
// amendment) work only in a Worker of a cross-origin isolated app, over its
// own synchronous request kind (SPAWN_SYNC, worker/sync-channel.ts) -- the
// grandchild runs on the SERVING side (spawn-sync.ts's runSpawnSync,
// child-process/spawn.ts's launch()), never here; only this thread blocks.
// On the page, or in a Worker with no SharedArrayBuffer, they still refuse
// by name: the calling thread cannot wait either way.

import { Buffer } from 'buffer'
import { SPAWN_SYNC } from '../worker/sync-channel.js'
import { getOrivon } from '../orivon-global.js'
import { refuseShim } from '../errors.js'
import { nodeModule } from '../polyfills/module-proxy.js'
import { splitCommand } from './command-line.js'
import { DEFAULT_MAX_BUFFER } from './exec.js'
import { environmentOf, validateCommand, type SpawnOptions } from './spawn.js'
import type { SpawnSyncRequest, SpawnSyncWireError, SpawnSyncWireResult } from './spawn-sync.js'
import { ChildProcess } from './child.js'
import { exec, execFile } from './exec.js'
import { fork } from './fork.js'
import { spawn } from './spawn.js'

type Output = string | Buffer

export interface SpawnSyncOptions extends SpawnOptions {
  readonly input?: string | Uint8Array
  readonly encoding?: BufferEncoding | 'buffer' | null
  readonly maxBuffer?: number
}

export interface SpawnSyncReturns {
  readonly pid: number | undefined
  /** `null`, not an empty buffer, for a child whose `stdio` was not 'pipe' -- Node reports no captured output the same way. */
  readonly output: readonly [null, Output | null, Output | null]
  readonly stdout: Output | null
  readonly stderr: Output | null
  readonly status: number | null
  readonly signal: string | null
  readonly error?: Error & { code?: string, errno?: number, syscall?: string, path?: string, spawnargs?: readonly string[] }
}

/** spawnSync/execFileSync/execSync's shared `stdio`: the one bare mode this synchronous family can honour (spawn-sync.ts's own SpawnSyncRequest doc says why); anything else -- a per-stream array, a file descriptor, a stream, `'ipc'` or `'overlapped'` -- refuses by name instead of silently becoming 'pipe'. */
function stdioModeOf (stdio: SpawnSyncOptions['stdio'], api: string): 'pipe' | 'ignore' | 'inherit' {
  if (stdio === undefined || stdio === null || stdio === 'pipe') return 'pipe'
  if (stdio === 'ignore' || stdio === 'inherit') return stdio
  throw refuseShim(
    `${api} options.stdio`, 'not-applicable',
    "this synchronous family supports 'pipe', 'ignore' and 'inherit' -- a per-stream array, a file descriptor or a stream names something only a real process has"
  )
}

/** child_process's own synchronous request (SPAWN_SYNC), or the same named refusal every *Sync export shares -- neither the page nor a Worker with no SharedArrayBuffer can block for a grandchild. */
function spawnSyncRequest (api: string, asyncApi: string): (payload: SpawnSyncRequest) => SpawnSyncWireResult {
  const fn = (getOrivon() as unknown as Record<symbol, ((payload: unknown) => unknown) | undefined>)[SPAWN_SYNC]
  if (fn === undefined) {
    throw refuseShim(
      api, 'not-applicable',
      `${api} works only in a forked child or a worker_threads.Worker of a cross-origin isolated app, ` +
      `over the synchronous channel -- use ${asyncApi} and its callback or promise here`
    )
  }
  return (payload) => fn(payload) as SpawnSyncWireResult
}

/** A wire error as a real Error -- every field Node puts on a spawnSync failure (spawn-sync.ts's own `wireErrorOf` doc says which), not just `name`/`message`/`code`. */
function errorOf (wire: SpawnSyncWireError): Error & { code?: string, errno?: number, syscall?: string, path?: string, spawnargs?: readonly string[] } {
  return Object.assign(new Error(wire.message), {
    name: wire.name,
    ...(wire.code === undefined ? {} : { code: wire.code }),
    ...(wire.errno === undefined ? {} : { errno: wire.errno }),
    ...(wire.syscall === undefined ? {} : { syscall: wire.syscall }),
    ...(wire.path === undefined ? {} : { path: wire.path }),
    ...(wire.spawnargs === undefined ? {} : { spawnargs: wire.spawnargs })
  })
}

function decodeOutput (bytes: Uint8Array | null, encoding: SpawnSyncOptions['encoding']): Output | null {
  if (bytes === null) return null
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return encoding === 'buffer' || encoding === null || encoding === undefined ? Buffer.from(buffer) : buffer.toString(encoding)
}

function inputBytes (input: SpawnSyncOptions['input']): Uint8Array | undefined {
  if (input === undefined) return undefined
  return typeof input === 'string' ? new Uint8Array(Buffer.from(input, 'utf8')) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
}

function spawnSyncCore (
  api: string, asyncApi: string, command: string, args: readonly string[], options: SpawnSyncOptions, forwardStderr: boolean
): SpawnSyncReturns {
  validateCommand(command)
  const stdio = stdioModeOf(options.stdio, api)
  const request = spawnSyncRequest(api, asyncApi)
  const input = inputBytes(options.input)
  const wire = request({
    command,
    args,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: environmentOf(options.env),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.killSignal === undefined ? {} : { killSignal: options.killSignal }),
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    ...(input === undefined ? {} : { input }),
    stdio,
    forwardStderr
  })
  const stdout = decodeOutput(wire.stdout, options.encoding)
  const stderr = decodeOutput(wire.stderr, options.encoding)
  return {
    pid: wire.pid,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status: wire.status,
    signal: wire.signal,
    ...(wire.error === undefined ? {} : { error: errorOf(wire.error) })
  }
}

export function spawnSync (command: string, argsOrOptions?: readonly string[] | SpawnSyncOptions, maybeOptions?: SpawnSyncOptions): SpawnSyncReturns {
  const args = Array.isArray(argsOrOptions) ? argsOrOptions : []
  const options = (Array.isArray(argsOrOptions) || argsOrOptions === undefined || argsOrOptions === null ? maybeOptions : argsOrOptions as SpawnSyncOptions) ?? {}
  return spawnSyncCore('child_process.spawnSync', 'child_process.spawn', command, args.map(String), options, false)
}

export function execFileSync (file: string, argsOrOptions?: readonly string[] | SpawnSyncOptions, maybeOptions?: SpawnSyncOptions): Output | null {
  const args = Array.isArray(argsOrOptions) ? argsOrOptions : []
  const options = (Array.isArray(argsOrOptions) || argsOrOptions === undefined || argsOrOptions === null ? maybeOptions : argsOrOptions as SpawnSyncOptions) ?? {}
  return finishOrThrow(spawnSyncCore('child_process.execFileSync', 'child_process.execFile', file, args.map(String), options, true), [file, ...args.map(String)].join(' '))
}

export function execSync (command: string, options?: SpawnSyncOptions): Output | null {
  const [file, ...args] = splitCommand(command)
  if (file === undefined) throw refuseShim('child_process.execSync', 'not-applicable', "The argument 'command' cannot be empty. Received ''")
  return finishOrThrow(spawnSyncCore('child_process.execSync', 'child_process.exec', file, args, options ?? {}, true), command)
}

/** execSync/execFileSync throw on a non-zero status or a signal, as Node's own do; spawnSync itself never throws for either -- only `.error` (a real spawn failure) is exceptional there. Either way the thrown error carries `pid`/`output`/`stdout`/`stderr`/`status`/`signal`, exactly as Node's own does (measured) -- not just a bare message. */
function finishOrThrow (result: SpawnSyncReturns, cmd: string): Output | null {
  const withResult = (error: Error): Error & { code?: string } => Object.assign(error, {
    pid: result.pid, output: result.output, stdout: result.stdout, stderr: result.stderr, status: result.status, signal: result.signal
  })
  if (result.error !== undefined) throw withResult(result.error)
  if (result.status !== 0 || result.signal !== null) {
    const stderrText = result.stderr === null ? '' : result.stderr.toString()
    const message = stderrText.length > 0 ? `Command failed: ${cmd}\n${stderrText}` : `Command failed: ${cmd}`
    throw withResult(new Error(message))
  }
  return result.stdout
}

export { ChildProcess, exec, execFile, fork, spawn }

// A287: the named-export gaps a bundled CommonJS require()'s namespace needs.
export * from './generated/child-process.js'

export default nodeModule('child_process', { ChildProcess, spawn, fork, exec, execFile, spawnSync, execSync, execFileSync })
