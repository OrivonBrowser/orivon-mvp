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
import { environmentOf, type SpawnOptions } from './spawn.js'
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
  readonly output: readonly [null, Output, Output]
  readonly stdout: Output
  readonly stderr: Output
  readonly status: number | null
  readonly signal: string | null
  readonly error?: Error & { code?: string }
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

/** A wire error (name, message, code?) as a real Error, the same shape orivon-client.ts's own toError builds for every other sync reply. */
function errorOf (wire: SpawnSyncWireError): Error & { code?: string } {
  return Object.assign(new Error(wire.message), { name: wire.name, ...(wire.code === undefined ? {} : { code: wire.code }) })
}

function decodeOutput (bytes: Uint8Array, encoding: SpawnSyncOptions['encoding']): Output {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return encoding === 'buffer' || encoding === null || encoding === undefined ? Buffer.from(buffer) : buffer.toString(encoding)
}

function inputBytes (input: SpawnSyncOptions['input']): Uint8Array | undefined {
  if (input === undefined) return undefined
  return typeof input === 'string' ? new Uint8Array(Buffer.from(input, 'utf8')) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
}

function spawnSyncCore (api: string, asyncApi: string, command: string, args: readonly string[], options: SpawnSyncOptions): SpawnSyncReturns {
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
    ...(input === undefined ? {} : { input })
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
  return spawnSyncCore('child_process.spawnSync', 'child_process.spawn', command, args.map(String), options)
}

export function execFileSync (file: string, argsOrOptions?: readonly string[] | SpawnSyncOptions, maybeOptions?: SpawnSyncOptions): Output {
  const args = Array.isArray(argsOrOptions) ? argsOrOptions : []
  const options = (Array.isArray(argsOrOptions) || argsOrOptions === undefined || argsOrOptions === null ? maybeOptions : argsOrOptions as SpawnSyncOptions) ?? {}
  return finishOrThrow(spawnSyncCore('child_process.execFileSync', 'child_process.execFile', file, args.map(String), options), [file, ...args.map(String)].join(' '))
}

export function execSync (command: string, options?: SpawnSyncOptions): Output {
  const [file, ...args] = splitCommand(command)
  if (file === undefined) throw refuseShim('child_process.execSync', 'not-applicable', "The argument 'command' cannot be empty. Received ''")
  return finishOrThrow(spawnSyncCore('child_process.execSync', 'child_process.exec', file, args, options ?? {}), command)
}

/** execSync/execFileSync throw on a non-zero status or a signal, as Node's own do; spawnSync itself never throws for either -- only `.error` (a real spawn failure) is exceptional there. */
function finishOrThrow (result: SpawnSyncReturns, cmd: string): Output {
  if (result.error !== undefined) throw result.error
  if (result.status !== 0 || result.signal !== null) {
    throw Object.assign(new Error(`Command failed: ${cmd}\n${result.stderr.toString()}`), {
      status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr
    })
  }
  return result.stdout
}

export { ChildProcess, exec, execFile, fork, spawn }

// A287: the named-export gaps a bundled CommonJS require()'s namespace needs.
export * from './generated/child-process.js'

export default nodeModule('child_process', { ChildProcess, spawn, fork, exec, execFile, spawnSync, execSync, execFileSync })
