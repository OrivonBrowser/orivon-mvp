// trackScope: the timers a forked child or thread gets are Node's, objects with ref, unref, refresh and
// close, and the child stays alive exactly as long as one ref'd timer, immediate or fetch is pending.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Liveness, trackScope } from '../liveness.js'

type Timer = { ref: () => Timer, unref: () => Timer, hasRef: () => boolean, refresh: () => Timer, close: () => Timer, [Symbol.toPrimitive]: () => number }

function tracked (): { scope: { setTimeout: (handler: () => void, ms?: number, ...args: unknown[]) => Timer, clearTimeout: (id: unknown) => void, setInterval: (handler: () => void, ms?: number) => Timer, clearInterval: (id: unknown) => void, setImmediate: (handler: () => void) => Timer, clearImmediate: (id: unknown) => void }, liveness: Liveness, idle: ReturnType<typeof vi.fn> } {
  const idle = vi.fn()
  const liveness = new Liveness(idle, (run) => { queueMicrotask(run) })
  const scope = {
    setTimeout: globalThis.setTimeout.bind(globalThis) as never,
    clearTimeout: globalThis.clearTimeout.bind(globalThis) as never,
    setInterval: globalThis.setInterval.bind(globalThis) as never,
    clearInterval: globalThis.clearInterval.bind(globalThis) as never,
    setImmediate: globalThis.setImmediate.bind(globalThis) as never,
    clearImmediate: globalThis.clearImmediate.bind(globalThis) as never
  }
  trackScope(scope, liveness)
  return { scope: scope as never, liveness, idle }
}

// The clock is the test's: no assertion depends on how long the machine takes to run a turn.
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

/** Moves the fake clock forward `ms`, running every timer, immediate and microtask that falls due. */
const sleep = async (ms: number): Promise<void> => { await vi.advanceTimersByTimeAsync(ms) }

describe('the timers of a child', () => {
  it('setTimeout returns a Node Timeout: it runs the handler with its arguments, and is a number when asked', async () => {
    const { scope } = tracked()
    const handler = vi.fn()
    const timer = scope.setTimeout(handler as never, 5, 'a', 'b')
    expect(typeof timer).toBe('object')
    for (const method of ['ref', 'unref', 'hasRef', 'refresh', 'close'] as const) expect(typeof timer[method]).toBe('function')
    expect(typeof Number(timer)).toBe('number')
    expect(Number.isFinite(Number(timer))).toBe(true)
    await sleep(25)
    expect(handler).toHaveBeenCalledWith('a', 'b')
  })

  it('is cleared by the object, by its number, and by close()', async () => {
    const { scope } = tracked()
    const handler = vi.fn()
    scope.clearTimeout(scope.setTimeout(handler, 5))
    const byNumber = scope.setTimeout(handler, 5)
    scope.clearTimeout(Number(byNumber))
    scope.setTimeout(handler, 5).close()
    await sleep(25)
    expect(handler).not.toHaveBeenCalled()
  })

  it('an unref\'d timer does not keep the child alive, and ref() takes it back', async () => {
    const { scope, liveness } = tracked()
    const timer = scope.setTimeout(() => {}, 30)
    expect(liveness.idle).toBe(false)
    expect(timer.unref()).toBe(timer)
    expect(timer.hasRef()).toBe(false)
    expect(liveness.idle).toBe(true)
    timer.ref()
    expect(timer.hasRef()).toBe(true)
    expect(liveness.idle).toBe(false)
    timer.close()
    expect(liveness.idle).toBe(true)
    timer.close()
    timer.unref().ref()
    expect(liveness.idle).toBe(true)
  })

  it('a fired timer lets the child end, and is counted once however it was ref\'d', async () => {
    const { scope, liveness, idle } = tracked()
    scope.setTimeout(() => {}, 5).unref().ref().ref()
    await sleep(25)
    expect(liveness.idle).toBe(true)
    expect(idle).toHaveBeenCalledTimes(1)
  })

  it('refresh() starts the wait again, also for a timer that already fired', async () => {
    const { scope, liveness } = tracked()
    const handler = vi.fn()
    const timer = scope.setTimeout(handler, 40)
    await sleep(25)
    timer.refresh()
    await sleep(25)
    expect(handler).not.toHaveBeenCalled()
    await sleep(15)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(liveness.idle).toBe(true)
    timer.refresh()
    expect(liveness.idle).toBe(false)
    await sleep(60)
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('setInterval is the same kind of object, repeats until cleared, and unref\'d does not hold the child', async () => {
    const { scope, liveness } = tracked()
    const handler = vi.fn()
    const timer = scope.setInterval(handler, 5)
    await sleep(40)
    expect(handler).toHaveBeenCalledTimes(8)
    timer.unref()
    expect(liveness.idle).toBe(true)
    scope.clearInterval(timer)
    const seen = handler.mock.calls.length
    await sleep(25)
    expect(handler.mock.calls.length).toBe(seen)
  })

  it('setImmediate returns an object with ref, unref and hasRef, and clearImmediate cancels it', async () => {
    const { scope, liveness } = tracked()
    const handler = vi.fn()
    const immediate = scope.setImmediate(handler)
    expect(typeof immediate.unref).toBe('function')
    scope.clearImmediate(immediate)
    expect(liveness.idle).toBe(true)
    await sleep(10)
    expect(handler).not.toHaveBeenCalled()
    scope.setImmediate(handler)
    await sleep(10)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
