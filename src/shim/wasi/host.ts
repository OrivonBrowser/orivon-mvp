// One program's wasi_snapshot_preview1 import functions, over orivon.fs.
// This adds errno translation and a descriptor table, never authority:
// every file call is an orivon.fs call the app could already make.

import { toConfinedPath } from '../fs/paths.js'
import { VIRTUAL_ROOT } from '../virtual-root.js'
import { HostContext, type WasiFs } from './context.js'
import { type SyncIo, runAsync, runSync } from './drivers.js'
import type { SyncWasiFs } from './effects.js'
import { Errno, errnoFor } from './errno.js'
import { PathError } from './fds.js'
import { InvalidUtf8 } from './memory.js'
import { directoryFunctions } from './preview1/directory.js'
import { environmentFunctions } from './preview1/environment.js'
import type { ImportFamily, SyncSink, WasiFunction } from './preview1/family.js'
import { fdFunctions } from './preview1/fd.js'
import { pathFunctions } from './preview1/path.js'
import { refusedFunctions } from './preview1/refused.js'
import { EMPTY_STDIN, type LineSink, type Sink, type StdinSource, lineSink } from './stdio.js'
import { isTermination } from './termination.js'

export type { WasiFs } from './context.js'
export type { SyncFileHandle, SyncWasiFs } from './effects.js'

export interface WasiHostOptions {
  readonly fs: WasiFs
  /** argv, `argv[0]` included. */
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  /** Guest directory name to a path under the virtual root. Default: `/` is the app's whole files root. */
  readonly preopens?: Readonly<Record<string, string>>
  readonly stdin?: StdinSource
  /** Default: the page console, one entry per line. */
  readonly stdout?: Sink
  readonly stderr?: Sink
  /** Where a synchronous module's stdout and stderr go (syncFunctions). Default: the page console. */
  readonly syncStdout?: SyncSink
  readonly syncStderr?: SyncSink
  /** What a synchronous module's file calls reach. Without it, each refuses with NOSYS and a console line. */
  readonly syncFs?: SyncWasiFs
}

export interface WasiHost {
  /** The wasi_snapshot_preview1 functions, before any JSPI wrapping. */
  readonly functions: Readonly<Record<string, WasiFunction>>
  /** The functions that may suspend: instantiate.ts wraps exactly these in WebAssembly.Suspending. */
  readonly suspending: ReadonlySet<string>
  /**
   * The same functions for a module JavaScript calls synchronously, which
   * cannot suspend: each file call is answered by `syncFs` before it
   * returns, and output goes to `syncStdout` and `syncStderr`.
   */
  readonly syncFunctions: Readonly<Record<string, WasiFunction>>
  /** Called once the instance exists, before its entry export runs. */
  bindMemory (memory: WebAssembly.Memory): void
  /** Stops the program at its next import, which throws WasiTerminated('killed'). */
  kill (): void
  /**
   * Closes every file the program left open and emits any half-written
   * console line. runCommand calls it when the program ends, however it ends:
   * an open handle holds a slot in the broker's per-app handle table.
   */
  finish (): Promise<void>
}

/**
 * What a thrown error becomes. A termination unwinds the program; an error
 * with no errno shape is a bug in this host and traps loudly rather than
 * reaching the program as a plausible EIO.
 */
function toErrno (error: unknown): number {
  if (isTermination(error)) throw error
  if (error instanceof PathError) return error.errno
  if (error instanceof RangeError) return Errno.FAULT
  if (error instanceof InvalidUtf8) return Errno.ILSEQ
  if (typeof (error as { code?: unknown } | null)?.code === 'string') return errnoFor(error)
  throw error
}

function consoleSink (emit: (line: string) => void, sinks: LineSink[]): Sink {
  const line = lineSink(emit)
  sinks.push(line)
  return line.sink
}

export function createWasiHost (options: WasiHostOptions): WasiHost {
  const lineSinks: LineSink[] = []
  const env = Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`)
  const ctx = new HostContext(
    options.fs,
    options.args ?? [],
    env,
    options.stdin ?? EMPTY_STDIN,
    options.stdout ?? consoleSink((line) => console.log(line), lineSinks),
    options.stderr ?? consoleSink((line) => console.error(line), lineSinks)
  )
  ctx.fds.add({ kind: 'stdin' })
  ctx.fds.add({ kind: 'stdout' })
  ctx.fds.add({ kind: 'stderr' })
  for (const [guestName, virtualPath] of Object.entries(options.preopens ?? { '/': VIRTUAL_ROOT })) {
    ctx.fds.add({ kind: 'directory', path: toConfinedPath(virtualPath, 'wasi preopen'), preopenName: guestName })
  }

  const families: ImportFamily[] = [
    environmentFunctions(ctx), fdFunctions(ctx), directoryFunctions(ctx), pathFunctions(ctx), refusedFunctions(ctx)
  ]
  const functions: Record<string, WasiFunction> = {}
  const suspending = new Set<string>()
  const guard = (fn: (...args: never[]) => number): WasiFunction => (...args: never[]) => {
    try {
      ctx.throwIfTerminated()
      return fn(...args)
    } catch (error) {
      return toErrno(error)
    }
  }
  for (const family of families) {
    for (const [name, fn] of Object.entries(family.sync)) functions[name] = guard(fn)
    for (const [name, op] of Object.entries(family.ops)) {
      suspending.add(name)
      functions[name] = async (...args: never[]) => {
        try {
          ctx.throwIfTerminated()
          return await runAsync(ctx, op(...args))
        } catch (error) {
          return toErrno(error)
        }
      }
    }
  }

  // Built on first use: only a synchronous module (a native addon) reads them.
  let syncFunctions: Record<string, WasiFunction> | undefined
  const buildSyncFunctions = (): Record<string, WasiFunction> => {
    const sinkOf = (given: SyncSink | undefined, emit: (line: string) => void): SyncSink => {
      if (given !== undefined) return given
      const line = lineSink(emit)
      lineSinks.push(line)
      return (bytes) => { void line.sink(bytes) }
    }
    const io: SyncIo = {
      fs: options.syncFs,
      stdout: sinkOf(options.syncStdout, (line) => console.log(line)),
      stderr: sinkOf(options.syncStderr, (line) => console.error(line))
    }
    const table: Record<string, WasiFunction> = { ...functions }
    for (const family of families) {
      for (const [name, op] of Object.entries(family.ops)) table[name] = guard((...args) => runSync(ctx, op(...args), io))
    }
    return table
  }

  return {
    functions,
    suspending,
    get syncFunctions () {
      syncFunctions ??= buildSyncFunctions()
      return syncFunctions
    },
    bindMemory: (memory) => ctx.memory.bind(memory),
    kill: () => ctx.terminate('killed'),
    finish: async () => {
      lineSinks.forEach((line) => line.flush())
      const open = [...ctx.fds.values()].flatMap((entry) => entry.kind === 'file' ? [entry.handle] : [])
      await Promise.allSettled(open.map(async (handle) => await handle.close()))
    }
  }
}
