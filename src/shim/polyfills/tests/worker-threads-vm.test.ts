// The `worker_threads` and `vm` module targets: importing either succeeds,
// what is true on the page answers truly, and what needs a second realm (vm)
// or a nested thread (worker_threads) refuses by name when used.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { WORKER_THREADS_SYMBOL } from '../../worker/runtime-thread.js'
import workerThreads, {
  BroadcastChannel, MessageChannel, MessagePort, Worker, getEnvironmentData, isMainThread, isMarkedAsUntransferable,
  markAsUntransferable, parentPort, setEnvironmentData, threadId, workerData
} from '../worker-threads.js'
import vm, { Script, compileFunction, createContext, isContext, runInNewContext, runInThisContext } from '../vm.js'

const refusal = (api: string, reason: string): unknown => expect.objectContaining({ name: 'OrivonShimError', api, reason })

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[WORKER_THREADS_SYMBOL]
})

describe('worker_threads', () => {
  it('answers as Node\'s main thread does, with none of the registered symbol a thread sets', () => {
    expect([isMainThread, threadId, parentPort, workerData]).toEqual([true, 0, null, null])
    expect(workerThreads.parentPort).toBeNull()
    expect(workerThreads.SHARE_ENV).toBe(Symbol.for('nodejs.worker_threads.SHARE_ENV'))
  })

  it('reads isMainThread, threadId, parentPort and workerData off the registered symbol a thread sets before this module evaluates', async () => {
    const fakePort = { fake: true }
    ;(globalThis as Record<symbol, unknown>)[WORKER_THREADS_SYMBOL] = { threadId: 3, workerData: { size: 4 }, parentPort: fakePort, resourceLimits: { maxOldGenerationSizeMb: 16 } }
    vi.resetModules()
    const reloaded = await import('../worker-threads.js')
    expect(reloaded.isMainThread).toBe(false)
    expect(reloaded.threadId).toBe(3)
    expect(reloaded.workerData).toEqual({ size: 4 })
    expect(reloaded.parentPort).toBe(fakePort)
    expect(reloaded.resourceLimits).toEqual({ maxOldGenerationSizeMb: 16 })
    vi.resetModules()
  })

  it('keeps environment data, and forgets a key set to undefined', () => {
    setEnvironmentData('pool', { size: 4 })
    expect(getEnvironmentData('pool')).toEqual({ size: 4 })
    setEnvironmentData('pool', undefined)
    expect(getEnvironmentData('pool')).toBeUndefined()
  })

  it('marks an object untransferable', () => {
    const buffer = new ArrayBuffer(8)
    expect(isMarkedAsUntransferable(buffer)).toBe(false)
    markAsUntransferable(buffer)
    expect(isMarkedAsUntransferable(buffer)).toBe(true)
    expect(isMarkedAsUntransferable(1)).toBe(false)
  })

  it('refuses eval and a nested thread by name, and a member it lacks when called', () => {
    expect(() => new Worker('/x.js', { eval: true })).toThrow(refusal('worker_threads.Worker', 'not-applicable'))
    ;(globalThis as Record<symbol, unknown>)[WORKER_THREADS_SYMBOL] = { threadId: 1, workerData: null, parentPort: null, resourceLimits: {} }
    expect(() => new Worker('/x.js')).toThrow(refusal('worker_threads.Worker', 'not-applicable'))
    delete (globalThis as Record<symbol, unknown>)[WORKER_THREADS_SYMBOL]
    const { receiveMessageOnPort, moveMessagePortToContext } = workerThreads as unknown as { receiveMessageOnPort: () => unknown, moveMessagePortToContext: () => unknown }
    expect(() => receiveMessageOnPort()).toThrow(refusal('worker_threads.receiveMessageOnPort', 'not-applicable'))
    expect(() => moveMessagePortToContext()).toThrow(refusal('worker_threads.moveMessagePortToContext', 'unimplemented'))
  })

  it('gives MessageChannel two Node-shaped ports that round-trip a message as a value, and exports MessagePort and the platform\'s BroadcastChannel', async () => {
    const channel = new MessageChannel()
    expect(channel.port1).toBeInstanceOf(MessagePort)
    expect(channel.port2).toBeInstanceOf(MessagePort)
    const reply = new Promise((resolve) => channel.port2.on('message', resolve))
    channel.port1.postMessage('ping')
    expect(await reply).toBe('ping')
    expect(BroadcastChannel).toBe(globalThis.BroadcastChannel)
  })
})

describe('vm', () => {
  it('runs code in the page\'s own context', () => {
    ;(globalThis as { vmProbe?: number }).vmProbe = 20
    try {
      expect(runInThisContext('vmProbe + 22')).toBe(42)
      expect(new Script('typeof globalThis').runInThisContext()).toBe('object')
      expect(vm.runInThisContext('var vmDeclared = 1; vmDeclared')).toBe(1)
    } finally {
      delete (globalThis as { vmProbe?: number }).vmProbe
      delete (globalThis as { vmDeclared?: number }).vmDeclared
    }
  })

  it('compiles a function with its parameters', () => {
    expect(compileFunction('return a * b', ['a', 'b'])(6, 7)).toBe(42)
  })

  it('refuses a context of its own by name, and reports that nothing is one', () => {
    expect(isContext({})).toBe(false)
    expect(() => createContext()).toThrow(refusal('vm.createContext', 'unimplemented'))
    expect(() => runInNewContext()).toThrow(refusal('vm.runInNewContext', 'unimplemented'))
    expect(() => new Script('1').runInNewContext()).toThrow(refusal('vm.Script.runInNewContext', 'unimplemented'))
    expect(() => compileFunction('return 1', [], { contextExtensions: [{}] })).toThrow(refusal('vm.compileFunction with a context', 'unimplemented'))
  })
})
