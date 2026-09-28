// State one running program's imports share: its memory, descriptors, the
// orivon.fs it reaches files through, and whether it has been stopped.

import type { OrivonFs } from '../../contracts/capability-api.js'
import type { FileStat } from '../../contracts/handles.js'
import { isRootPath, rootStat } from '../fs/root.js'
import { Filetype, type Filestat, GuestMemory } from './memory.js'
import { FdTable, inodeFor } from './fds.js'
import type { Sink, StdinSource } from './stdio.js'
import { WasiTerminated, type WasiTerminationReason } from './termination.js'

/** The part of orivon.fs a WASI program can reach. A Worker's proxy provides the same shape. */
export type WasiFs = Pick<OrivonFs, 'open' | 'stat' | 'readdir' | 'mkdir' | 'rm' | 'rename'>

/** In-flight and rate limits clear on their own; a program has no code path for EAGAIN on a file. */
const LIMIT_RETRY_DELAYS_MS = [5, 20, 80] as const

function delay (ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function orivonCode (error: unknown): { code?: unknown, platformCode?: unknown } {
  return typeof error === 'object' && error !== null ? error as { code?: unknown, platformCode?: unknown } : {}
}

export class HostContext {
  readonly memory = new GuestMemory()
  readonly fds = new FdTable()
  readonly fs: WasiFs
  readonly args: readonly string[]
  readonly env: readonly string[]
  readonly stdin: StdinSource
  readonly stdout: Sink
  readonly stderr: Sink
  #terminated: WasiTerminationReason | undefined
  readonly #warned = new Set<string>()

  constructor (fs: WasiFs, args: readonly string[], env: readonly string[], stdin: StdinSource, stdout: Sink, stderr: Sink) {
    this.fs = fs
    this.args = args
    this.env = env
    this.stdin = stdin
    this.stdout = stdout
    this.stderr = stderr
  }

  terminate (reason: WasiTerminationReason): void {
    this.#terminated ??= reason
  }

  throwIfTerminated (): void {
    if (this.#terminated !== undefined) throw new WasiTerminated(this.#terminated)
  }

  /** One orivon.fs call: a transient limit is retried, a revoked grant stops the program. */
  async fsCall<T> (run: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      this.throwIfTerminated()
      try {
        const result = await run()
        this.throwIfTerminated()
        return result
      } catch (error) {
        const { code, platformCode } = orivonCode(error)
        if (code === 'revoked') this.terminate('revoked')
        this.throwIfTerminated()
        const retryDelay = LIMIT_RETRY_DELAYS_MS[attempt]
        if (code === 'limit' && platformCode === undefined && retryDelay !== undefined) {
          await delay(retryDelay)
          continue
        }
        throw error
      }
    }
  }

  /** The broker refuses the root itself; fs/root.ts answers it locally, as the Node shim does. */
  async stat (path: string): Promise<FileStat> {
    if (isRootPath(path)) return rootStat()
    return await this.fsCall(() => this.fs.stat(path))
  }

  /** `stat`, or undefined when nothing is there. */
  async statIfExists (path: string): Promise<FileStat | undefined> {
    try {
      return await this.stat(path)
    } catch (error) {
      if (orivonCode(error).code === 'notFound') return undefined
      throw error
    }
  }

  /** A gap is named, never silent: one console line per program per call it cannot serve. */
  warnOnce (call: string, why: string): void {
    if (this.#warned.has(call)) return
    this.#warned.add(call)
    console.warn(`orivon WASI host: ${call} is not supported (${why})`)
  }
}

export function filestatOf (path: string, stat: FileStat): Filestat {
  const wholeMs = Math.trunc(stat.mtimeMs)
  return {
    ino: inodeFor(path),
    filetype: stat.isDirectory ? Filetype.DIRECTORY : stat.isFile ? Filetype.REGULAR_FILE : Filetype.UNKNOWN,
    size: BigInt(stat.size),
    mtimNs: BigInt(wholeMs) * 1_000_000n + BigInt(Math.round((stat.mtimeMs - wholeMs) * 1_000_000))
  }
}
