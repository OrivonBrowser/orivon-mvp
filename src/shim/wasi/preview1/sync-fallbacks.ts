// What a module whose exports JavaScript calls synchronously (a native
// addon's WebAssembly build) gets for the imports that would suspend: it has
// no `promising` entry, so it cannot wait on orivon.fs. Standard output and
// error still work, straight to the embedder's synchronous sinks; a yield
// returns at once; every other one refuses by name.

import type { HostContext } from '../context.js'
import { Errno } from '../errno.js'
import type { WasiFunction } from './family.js'

/** A sink that has taken the bytes by the time it returns. */
export type SyncSink = (bytes: Uint8Array) => void

export function syncFallbacks (ctx: HostContext, suspending: ReadonlySet<string>, sinks: { stdout: SyncSink, stderr: SyncSink }): Record<string, WasiFunction> {
  const fallbacks: Record<string, WasiFunction> = {}
  for (const name of suspending) {
    fallbacks[name] = () => {
      ctx.warnOnce(name, 'a synchronous module cannot wait on orivon.fs; run it through child_process, where it can')
      return Errno.NOSYS
    }
  }
  fallbacks.sched_yield = () => Errno.SUCCESS
  fallbacks.fd_write = ((fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number) => {
    const entry = ctx.fds.get(fd)
    if (entry === undefined) return Errno.BADF
    if (entry.kind !== 'stdout' && entry.kind !== 'stderr') {
      ctx.warnOnce('fd_write', 'a synchronous module can write only to stdout and stderr')
      return Errno.NOSYS
    }
    const data = ctx.memory.gather(ctx.memory.iovecs(iovsPtr, iovsLen))
    sinks[entry.kind](data)
    ctx.memory.u32(nwrittenPtr, data.length)
    return Errno.SUCCESS
  }) as WasiFunction
  return fallbacks
}
