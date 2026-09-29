// The `worker_threads` and `vm` module targets: importing either succeeds,
// what is true on the page answers truly, and what needs a thread or a second
// realm refuses by name when used.

import { describe, expect, it } from 'vitest'
import workerThreads, { Worker, getEnvironmentData, isMainThread, isMarkedAsUntransferable, markAsUntransferable, parentPort, setEnvironmentData, threadId, workerData } from '../worker-threads.js'
import vm, { Script, compileFunction, createContext, isContext, runInNewContext, runInThisContext } from '../vm.js'

const refusal = (api: string, reason: string): unknown => expect.objectContaining({ name: 'OrivonShimError', api, reason })

describe('worker_threads', () => {
  it('answers as Node\'s main thread does', () => {
    expect([isMainThread, threadId, parentPort, workerData]).toEqual([true, 0, null, null])
    expect(workerThreads.parentPort).toBeNull()
    expect(workerThreads.SHARE_ENV).toBe(Symbol.for('nodejs.worker_threads.SHARE_ENV'))
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

  it('refuses to start a thread by name, and a member it lacks when called', () => {
    expect(() => new Worker()).toThrow(refusal('worker_threads.Worker', 'not-built'))
    const { receiveMessageOnPort } = workerThreads as unknown as { receiveMessageOnPort: () => unknown }
    expect(() => receiveMessageOnPort()).toThrow(refusal('worker_threads.receiveMessageOnPort', 'unimplemented'))
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
