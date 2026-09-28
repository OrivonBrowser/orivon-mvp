// Runs an import function (a generator of effects.ts's effects) to its errno.
// The asynchronous driver awaits each effect on orivon.fs, the program
// suspended through JSPI meanwhile. The synchronous driver answers each at
// once from a SyncWasiFs, for a module JavaScript calls directly; with none,
// a file effect refuses by name.

import type { HostContext } from './context.js'
import { Errno } from './errno.js'
import type { Effect, Op, SyncWasiFs } from './effects.js'
import { PathError } from './fds.js'
import type { SyncSink } from './preview1/family.js'
import { isTermination } from './termination.js'

/** A value that arrives after the program was stopped: an opened file is closed rather than leaked. */
function closeLate (value: unknown): void {
  void (value as { close?: () => Promise<void> }).close?.().catch(() => {})
}

type Method = (...args: unknown[]) => unknown

function methodOf (target: unknown, name: string): Method {
  const method = (target as Record<string, Method>)[name] as Method
  return (...args) => method.apply(target, args)
}

async function performAsync (ctx: HostContext, effect: Effect): Promise<unknown> {
  switch (effect.kind) {
    case 'fs': {
      const call = methodOf(ctx.fs, effect.method) as (...args: unknown[]) => Promise<unknown>
      return await ctx.fsCall(async () => await call(...effect.args), effect.method === 'open' ? closeLate : undefined)
    }
    case 'handle': {
      const call = methodOf(effect.handle, effect.method) as (...args: unknown[]) => Promise<unknown>
      return await ctx.fsCall(async () => await call(...effect.args))
    }
    case 'stdin': return await ctx.untilTerminated(ctx.stdin.read(effect.max))
    case 'output': return await ctx.untilTerminated(Promise.resolve((effect.stream === 'stdout' ? ctx.stdout : ctx.stderr)(effect.data)))
    case 'sleep': return await ctx.untilTerminated(ctx.sleep(effect.ms))
    case 'all': return await Promise.all(effect.ops.map(async (op) => await runAsync(ctx, op)))
  }
}

/**
 * Feeds each effect's outcome back into `op`. A termination is never thrown
 * into it, where a catch could swallow it: the op is closed (its finally
 * blocks run) and the termination goes on up.
 */
export async function runAsync<T> (ctx: HostContext, op: Op<T>): Promise<T> {
  let step = op.next()
  while (step.done !== true) {
    let value: unknown
    try {
      value = await performAsync(ctx, step.value)
    } catch (error) {
      if (isTermination(error)) {
        op.return(undefined as T)
        throw error
      }
      step = op.throw(error)
      continue
    }
    step = op.next(value)
  }
  return step.value
}

/** What the synchronous driver answers effects from. */
export interface SyncIo {
  /** Undefined on a page's main thread, which cannot block on the page that serves orivon.fs. */
  readonly fs: SyncWasiFs | undefined
  readonly stdout: SyncSink
  readonly stderr: SyncSink
}

let waitCell: Int32Array | null | undefined

/**
 * Blocks the thread for `ms`, as a synchronous module asked. Atomics.wait
 * where the thread may wait; a page's main thread may not, and spins.
 */
export function blockFor (ms: number): void {
  if (ms <= 0) return
  waitCell ??= typeof SharedArrayBuffer === 'function' ? new Int32Array(new SharedArrayBuffer(4)) : null
  if (waitCell !== null) {
    try {
      Atomics.wait(waitCell, 0, 0, ms)
      return
    } catch {
      waitCell = null
    }
  }
  const until = performance.now() + ms
  while (performance.now() < until) continue
}

function performSync (ctx: HostContext, effect: Effect, io: SyncIo): unknown {
  switch (effect.kind) {
    case 'fs': {
      if (io.fs === undefined) {
        ctx.warnOnce('file access', 'a synchronous module on the page\'s main thread cannot wait on orivon.fs; load it in a forked child of a cross-origin isolated app')
        throw new PathError(Errno.NOSYS)
      }
      const call = methodOf(io.fs, effect.method)
      return ctx.fsCallSync(() => call(...effect.args), blockFor)
    }
    case 'handle': {
      const call = methodOf(effect.handle, effect.method)
      return ctx.fsCallSync(() => call(...effect.args), blockFor)
    }
    case 'stdin': return new Uint8Array(0)
    case 'output': io[effect.stream](effect.data); return undefined
    case 'sleep': blockFor(effect.ms); return undefined
    case 'all': return effect.ops.map((op) => runSync(ctx, op, io))
  }
}

/** runAsync's loop, with each effect answered before it returns. */
export function runSync<T> (ctx: HostContext, op: Op<T>, io: SyncIo): T {
  let step = op.next()
  while (step.done !== true) {
    let value: unknown
    try {
      ctx.throwIfTerminated()
      value = performSync(ctx, step.value, io)
    } catch (error) {
      if (isTermination(error)) {
        op.return(undefined as T)
        throw error
      }
      step = op.throw(error)
      continue
    }
    step = op.next(value)
  }
  return step.value
}
