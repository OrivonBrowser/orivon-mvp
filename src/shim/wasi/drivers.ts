// Runs an import function (a generator of effects.ts's effects) to its errno.
// The asynchronous driver awaits each effect on orivon.fs, the program
// suspended through JSPI meanwhile. The synchronous driver answers each at
// once from a SyncWasiFs, for a module JavaScript calls directly; with none,
// a file effect refuses by name.

import { type HostContext, orivonCode } from './context.js'
import { Errno } from './errno.js'
import type { Effect, Op, SyncWasiFs } from './effects.js'
import { PathError } from './fds.js'
import type { SyncSink } from './preview1/family.js'
import { isTermination } from './termination.js'

type Outcome = { readonly value: unknown } | { readonly error: unknown }

/**
 * Feeds an effect's outcome back into `op`. A termination is never thrown
 * into it, where a catch could swallow it: the op is closed (its finally
 * blocks run) and the termination goes on up.
 */
function resume<T> (op: Op<T>, outcome: Outcome): IteratorResult<Effect, T> {
  if (!('error' in outcome)) return op.next(outcome.value)
  if (isTermination(outcome.error)) {
    op.return(undefined as T)
    throw outcome.error
  }
  return op.throw(outcome.error)
}

type Method = (...args: unknown[]) => unknown

function methodOf (target: unknown, name: string): Method {
  const method = (target as Record<string, Method>)[name] as Method
  return (...args) => method.apply(target, args)
}

/** A value that arrives after the program was stopped: an opened file is closed rather than leaked. */
function closeLate (value: unknown): void {
  void (value as { close?: () => Promise<void> }).close?.().catch(() => {})
}

/** setTimeout's largest delay; a longer wait is taken in slices of this. */
const MAX_TIMER_MS = 2 ** 31 - 1

/** A pause; zero yields once to the event loop. */
async function delay (ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= MAX_TIMER_MS) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(left, MAX_TIMER_MS)))
  }
  if (ms <= 0) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** A program's file call: a revoked grant stops the program, since one retrying against a root that is gone would spin. */
async function fileCall (ctx: HostContext, work: Promise<unknown>, discard?: (value: unknown) => void): Promise<unknown> {
  try {
    return await ctx.untilTerminated(work, discard)
  } catch (error) {
    if (orivonCode(error) === 'revoked') ctx.terminate('revoked')
    ctx.throwIfTerminated()
    throw error
  }
}

async function performAsync (ctx: HostContext, effect: Effect): Promise<unknown> {
  switch (effect.kind) {
    case 'fs': return await fileCall(ctx, Promise.resolve().then(() => methodOf(ctx.fs, effect.method)(...effect.args)), effect.method === 'open' ? closeLate : undefined)
    case 'handle': return await fileCall(ctx, Promise.resolve().then(() => methodOf(effect.handle, effect.method)(...effect.args)))
    case 'stdin': return await ctx.untilTerminated(ctx.stdin.read(effect.max))
    case 'output': return await ctx.untilTerminated(Promise.resolve((effect.stream === 'stdout' ? ctx.stdout : ctx.stderr)(effect.data)))
    case 'sleep': return await ctx.untilTerminated(delay(effect.ms))
    case 'all': return await Promise.all(effect.ops.map(async (op) => await runAsync(ctx, op)))
  }
}

export async function runAsync<T> (ctx: HostContext, op: Op<T>): Promise<T> {
  let step = op.next()
  while (step.done !== true) {
    let outcome: Outcome
    try {
      outcome = { value: await performAsync(ctx, step.value) }
    } catch (error) {
      outcome = { error }
    }
    step = resume(op, outcome)
  }
  return step.value
}

/** What the synchronous driver answers effects from. */
export interface SyncIo {
  /** Undefined where the thread cannot block on the page: its main thread, or an app that is not cross-origin isolated. */
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

/**
 * A revoked grant is only that call's error here, never a stop: an addon's
 * host outlives any one call, and its caller handles the error.
 */
function performSync (ctx: HostContext, effect: Effect, io: SyncIo): unknown {
  switch (effect.kind) {
    case 'fs': {
      if (io.fs === undefined) {
        ctx.warnOnce('file access', 'a synchronous module reaches files only in a forked child of a cross-origin isolated app, where it can block on the page')
        throw new PathError(Errno.NOSYS)
      }
      return methodOf(io.fs, effect.method)(...effect.args)
    }
    case 'handle': return methodOf(effect.handle, effect.method)(...effect.args)
    case 'stdin':
      ctx.warnOnce('stdin', 'a synchronous module cannot wait for input, so it reads end of input')
      return new Uint8Array(0)
    case 'output': io[effect.stream](effect.data); return undefined
    case 'sleep': blockFor(effect.ms); return undefined
    case 'all': return effect.ops.map((op) => runSync(ctx, op, io))
  }
}

/** runAsync's loop, with each effect answered before it returns. */
export function runSync<T> (ctx: HostContext, op: Op<T>, io: SyncIo): T {
  let step = op.next()
  while (step.done !== true) {
    let outcome: Outcome
    try {
      ctx.throwIfTerminated()
      outcome = { value: performSync(ctx, step.value, io) }
    } catch (error) {
      outcome = { error }
    }
    step = resume(op, outcome)
  }
  return step.value
}
