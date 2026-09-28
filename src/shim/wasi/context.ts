// State one running program's imports share: its memory, descriptors, the
// orivon.fs it reaches files through, and whether it has been stopped.

import type { OrivonFs } from '../../contracts/capability-api.js'
import type { FileStat } from '../../contracts/handles.js'
import { isRootPath, rootStat } from '../fs/root.js'
import { type Op, fsCall } from './effects.js'
import { Filetype, type Filestat, GuestMemory } from './memory.js'
import { FdTable, inodeFor } from './fds.js'
import type { Sink, StdinSource } from './stdio.js'
import { WasiTerminated, type WasiTerminationReason } from './termination.js'

/** The part of orivon.fs a WASI program can reach. A Worker's proxy provides the same shape. */
export type WasiFs = Pick<OrivonFs, 'open' | 'stat' | 'readdir' | 'mkdir' | 'rm' | 'rename'>

export function orivonCode (error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
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
  readonly #termination: Promise<never>
  #rejectTermination: (error: WasiTerminated) => void = () => {}
  readonly #warned = new Set<string>()

  constructor (fs: WasiFs, args: readonly string[], env: readonly string[], stdin: StdinSource, stdout: Sink, stderr: Sink) {
    this.fs = fs
    this.args = args
    this.env = env
    this.stdin = stdin
    this.stdout = stdout
    this.stderr = stderr
    this.#termination = new Promise<never>((_resolve, reject) => { this.#rejectTermination = reject })
    this.#termination.catch(() => {})
  }

  terminate (reason: WasiTerminationReason): void {
    if (this.#terminated !== undefined) return
    this.#terminated = reason
    this.#rejectTermination(new WasiTerminated(reason))
  }

  throwIfTerminated (): void {
    if (this.#terminated !== undefined) throw new WasiTerminated(this.#terminated)
  }

  /**
   * Awaits `work` unless the program is stopped first, so kill() also ends a
   * program suspended on a read that never resolves. A value that arrives
   * after the stop goes to `discard`: an open handle is closed, not leaked.
   */
  async untilTerminated<T> (work: Promise<T>, discard?: (value: T) => void): Promise<T> {
    this.throwIfTerminated()
    work.then((value) => { if (this.#terminated !== undefined) discard?.(value) }, () => {})
    return await Promise.race([work, this.#termination])
  }

  /** The broker refuses the root itself; fs/root.ts answers it locally, as the Node shim does. */
  * stat (path: string): Op<FileStat> {
    if (isRootPath(path)) return rootStat()
    return yield * fsCall<FileStat>('stat', path)
  }

  /** `stat`, or undefined when nothing is there. */
  * statIfExists (path: string): Op<FileStat | undefined> {
    try {
      return yield * this.stat(path)
    } catch (error) {
      if (orivonCode(error) === 'notFound') return undefined
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
