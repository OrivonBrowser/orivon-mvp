// Arguments, environment, clocks, randomness, exit and poll_oneoff: the
// calls that touch no file.

import type { HostContext } from '../context.js'
import { sleep } from '../effects.js'
import { Errno } from '../errno.js'
import { encodeUtf8, unsigned } from '../memory.js'
import { WasiExit } from '../termination.js'
import type { ImportFamily } from './family.js'
import { Clock, EventType, SUBSCRIPTION_CLOCK_ABSTIME } from './flags.js'

/** crypto.getRandomValues refuses more than this per call. */
const RANDOM_CHUNK = 65_536
const SUBSCRIPTION_SIZE = 48
const EVENT_SIZE = 32
const RESOLUTION_NS = 1_000n
function msToNs (ms: number): bigint {
  const whole = Math.trunc(ms)
  return BigInt(whole) * 1_000_000n + BigInt(Math.round((ms - whole) * 1_000_000))
}

function now (clock: number): bigint | undefined {
  if (clock === Clock.REALTIME) return msToNs(performance.timeOrigin + performance.now())
  if (clock === Clock.MONOTONIC) return msToNs(performance.now())
  return undefined
}

/** argv or environ as preview1 lays them out: a pointer table, then the NUL-terminated strings. */
function writeStrings (ctx: HostContext, strings: readonly string[], tablePtr: number, bufPtr: number): number {
  let offset = unsigned(bufPtr)
  strings.forEach((text, index) => {
    const bytes = encodeUtf8(`${text}\0`)
    ctx.memory.u32(unsigned(tablePtr) + index * 4, offset)
    ctx.memory.bytes(offset, bytes.length).set(bytes)
    offset += bytes.length
  })
  return Errno.SUCCESS
}

function writeSizes (ctx: HostContext, strings: readonly string[], countPtr: number, sizePtr: number): number {
  ctx.memory.u32(countPtr, strings.length)
  ctx.memory.u32(sizePtr, strings.reduce((sum, text) => sum + encodeUtf8(text).length + 1, 0))
  return Errno.SUCCESS
}

interface Subscription {
  readonly userdata: bigint
  readonly type: number
  readonly fd: number
  /** Clock subscriptions: nanoseconds from now until it fires. */
  readonly waitNs: bigint
}

function readSubscriptions (ctx: HostContext, inPtr: number, count: number): Subscription[] | number {
  const subscriptions: Subscription[] = []
  for (let i = 0; i < count; i++) {
    const at = inPtr + i * SUBSCRIPTION_SIZE
    const userdata = ctx.memory.readU64(at)
    const type = ctx.memory.readU8(at + 8)
    if (type === EventType.CLOCK) {
      const clockNow = now(ctx.memory.readU32(at + 16))
      if (clockNow === undefined) return Errno.INVAL
      const timeout = ctx.memory.readU64(at + 24)
      const absolute = (ctx.memory.readU16(at + 40) & SUBSCRIPTION_CLOCK_ABSTIME) !== 0
      const waitNs = absolute ? timeout - clockNow : timeout
      subscriptions.push({ userdata, type, fd: -1, waitNs: waitNs > 0n ? waitNs : 0n })
    } else if (type === EventType.FD_READ || type === EventType.FD_WRITE) {
      subscriptions.push({ userdata, type, fd: ctx.memory.readU32(at + 16), waitNs: 0n })
    } else {
      return Errno.INVAL
    }
  }
  return subscriptions
}

function writeEvent (ctx: HostContext, at: number, subscription: Subscription, error: number): void {
  ctx.memory.bytes(at, EVENT_SIZE).fill(0)
  ctx.memory.u64(at, subscription.userdata)
  ctx.memory.u16(at + 8, error)
  ctx.memory.u8(at + 10, subscription.type)
}

export function environmentFunctions (ctx: HostContext): ImportFamily {
  return {
    sync: {
      args_sizes_get: (countPtr: number, sizePtr: number) => writeSizes(ctx, ctx.args, countPtr, sizePtr),
      args_get: (argvPtr: number, bufPtr: number) => writeStrings(ctx, ctx.args, argvPtr, bufPtr),
      environ_sizes_get: (countPtr: number, sizePtr: number) => writeSizes(ctx, ctx.env, countPtr, sizePtr),
      environ_get: (environPtr: number, bufPtr: number) => writeStrings(ctx, ctx.env, environPtr, bufPtr),
      clock_res_get: (clock: number, ptr: number) => {
        if (now(clock) === undefined) return clock <= Clock.THREAD_CPUTIME ? Errno.NOTSUP : Errno.INVAL
        ctx.memory.u64(ptr, RESOLUTION_NS)
        return Errno.SUCCESS
      },
      clock_time_get: (clock: number, _precision: bigint, ptr: number) => {
        const time = now(clock)
        if (time === undefined) return clock <= Clock.THREAD_CPUTIME ? Errno.NOTSUP : Errno.INVAL
        ctx.memory.u64(ptr, time)
        return Errno.SUCCESS
      },
      random_get: (ptr: number, rawLen: number) => {
        const len = unsigned(rawLen)
        // Filled in a scratch buffer and copied: getRandomValues refuses a
        // view over a shared memory, which a threaded build's is.
        const scratch = new Uint8Array(Math.min(len, RANDOM_CHUNK))
        for (let offset = 0; offset < len; offset += RANDOM_CHUNK) {
          const size = Math.min(RANDOM_CHUNK, len - offset)
          crypto.getRandomValues(scratch.subarray(0, size))
          ctx.memory.bytes(unsigned(ptr) + offset, size).set(scratch.subarray(0, size))
        }
        return Errno.SUCCESS
      },
      proc_exit: (code: number) => {
        throw new WasiExit(code)
      }
    },
    ops: {
      * sched_yield () {
        yield * sleep(0)
        return Errno.SUCCESS
      },
      * poll_oneoff (inPtr: number, outPtr: number, count: number, eventCountPtr: number) {
        if (unsigned(count) === 0) return Errno.INVAL
        const subscriptions = readSubscriptions(ctx, unsigned(inPtr), unsigned(count))
        if (typeof subscriptions === 'number') return subscriptions
        // Files are always ready, as on POSIX; only clocks make a program wait.
        let ready = subscriptions.filter((sub) => sub.type !== EventType.CLOCK || sub.waitNs === 0n)
        if (ready.length === 0) {
          const soonest = subscriptions.reduce((min, sub) => sub.waitNs < min.waitNs ? sub : min)
          yield * sleep(Number(soonest.waitNs / 1_000_000n))
          ready = [soonest]
        }
        ready.forEach((sub, index) => {
          const valid = sub.type === EventType.CLOCK || ctx.fds.get(sub.fd) !== undefined
          writeEvent(ctx, unsigned(outPtr) + index * EVENT_SIZE, sub, valid ? Errno.SUCCESS : Errno.BADF)
        })
        ctx.memory.u32(eventCountPtr, ready.length)
        return Errno.SUCCESS
      }
    }
  }
}
