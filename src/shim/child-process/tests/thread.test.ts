// worker_threads.Worker end to end in Node: the real Worker class, the real
// Worker runtime run in-process (support/in-process-worker.ts), and a real
// directory standing in for the broker (launch() always serves orivon.*,
// whether or not a thread's own module happens to call it).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Orivon } from '../../../contracts/capability-api.js'
import { OrivonShimError } from '../../errors.js'
import { createRealDiskFs, type RealDiskFs } from '../../tests/support/real-disk-fs.js'
import type { NodeMessagePort } from '../../worker/node-port.js'
import { FORK_LIVENESS_SYMBOL, WORKER_THREADS_SYMBOL, type WorkerThreadsGlobals } from '../../worker/symbols.js'
import { fork } from '../fork.js'
import { Worker } from '../thread.js'
import { forkModules, threadModules } from './support/in-process-worker.js'

vi.mock('../../worker/launch.js', async () => ({ createChildWorker: (await import('./support/in-process-worker.js')).createInProcessWorker }))

const ORIGIN = 'https://thread-unit.test'

/** What runtime-thread.ts put on the thread's own scope, read the way the polyfill would. */
function threadGlobals (scope: object): WorkerThreadsGlobals {
  return (scope as unknown as Record<symbol, WorkerThreadsGlobals>)[WORKER_THREADS_SYMBOL] as WorkerThreadsGlobals
}

let disk: RealDiskFs

beforeEach(async () => {
  disk = await createRealDiskFs()
  vi.stubGlobal('location', { origin: ORIGIN })
  vi.stubGlobal('orivon', disk.orivon as Orivon)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  forkModules.clear()
  threadModules.clear()
  delete (globalThis as Record<symbol, unknown>)[WORKER_THREADS_SYMBOL]
  delete (globalThis as Record<symbol, unknown>)[FORK_LIVENESS_SYMBOL]
  await disk.cleanup()
})

describe('Worker', () => {
  it('gives the thread its workerData, threadId and resourceLimits, and round-trips a message as a value, not an event', async () => {
    threadModules.set(`${ORIGIN}/echo.js`, (scope) => {
      const globals = threadGlobals(scope)
      globals.parentPort.on('message', (value: unknown) => {
        globals.parentPort.postMessage({ echoed: value, workerData: globals.workerData, threadId: globals.threadId, resourceLimits: globals.resourceLimits })
      })
    })
    const worker = new Worker('/echo.js', { workerData: { size: 4 } })
    const reply = new Promise((resolve) => worker.once('message', resolve))
    worker.postMessage('ping')
    expect(await reply).toEqual({ echoed: 'ping', workerData: { size: 4 }, threadId: worker.threadId, resourceLimits: {} })
    await worker.terminate()
  })

  it('wraps a port that arrives in a message one level deep, the same wrapper for the same web port', async () => {
    threadModules.set(`${ORIGIN}/port.js`, (scope) => {
      const globals = threadGlobals(scope)
      globals.parentPort.on('message', (value: unknown) => {
        const { a, b } = value as { a: NodeMessagePort, b: NodeMessagePort }
        globals.parentPort.postMessage({ isPort: typeof a.postMessage === 'function', same: a === b })
      })
    })
    const worker = new Worker('/port.js')
    const channel = new MessageChannel()
    const reply = new Promise((resolve) => worker.once('message', resolve))
    worker.postMessage({ a: channel.port2, b: channel.port2 }, [channel.port2])
    expect(await reply).toEqual({ isPort: true, same: true })
    await worker.terminate()
  })

  it('resolves terminate() with 1, as a killed thread exits in Node', async () => {
    threadModules.set(`${ORIGIN}/loop.js`, (scope) => { threadGlobals(scope).parentPort.on('message', () => {}) })
    const worker = new Worker('/loop.js')
    await new Promise((resolve) => worker.once('online', resolve))
    expect(await worker.terminate()).toBe(1)
  })

  it('ends on its own with code 0 once its last parentPort listener goes', async () => {
    threadModules.set(`${ORIGIN}/quiet.js`, (scope) => {
      const globals = threadGlobals(scope)
      const handler = (): void => {}
      globals.parentPort.on('message', handler)
      globals.parentPort.off('message', handler)
    })
    const worker = new Worker('/quiet.js')
    const code = await new Promise((resolve) => worker.once('exit', resolve))
    expect(code).toBe(0)
    // Node resolves terminate() on a thread that has already exited, with undefined.
    expect(await worker.terminate()).toBeUndefined()
  })

  it('reports process.exit(3) as its own exit code', async () => {
    threadModules.set(`${ORIGIN}/exits.js`, (scope) => { (scope.process as unknown as { exit: (code: number) => never }).exit(3) })
    const worker = new Worker('/exits.js')
    expect(await new Promise((resolve) => worker.once('exit', resolve))).toBe(3)
  })

  it('reaches \'error\' with the real Error, then \'exit\' 1, for an uncaught error', async () => {
    threadModules.set(`${ORIGIN}/throws.js`, () => { throw new Error('thread boom') })
    const worker = new Worker('/throws.js')
    const seen: string[] = []
    const error = new Promise((resolve) => worker.once('error', (err: Error) => { seen.push('error'); resolve(err) }))
    const exit = new Promise((resolve) => worker.once('exit', (code: number) => { seen.push('exit'); resolve(code) }))
    expect((await error as Error).message).toBe('thread boom')
    expect(await exit).toBe(1)
    expect(seen).toEqual(['error', 'exit'])
  })

  it('refuses eval and a nested thread by name', () => {
    expect(() => new Worker('/x.js', { eval: true })).toThrow(OrivonShimError)
    ;(globalThis as Record<symbol, unknown>)[WORKER_THREADS_SYMBOL] = { threadId: 1, workerData: null, parentPort: null, resourceLimits: {} }
    expect(() => new Worker('/x.js')).toThrow(OrivonShimError)
  })

  it('keeps a forked child alive while a ref\'d thread inside it runs, and lets it end once the thread does', async () => {
    let hosted: Worker | undefined
    threadModules.set(`${ORIGIN}/loop.js`, (scope) => { threadGlobals(scope).parentPort.on('message', () => {}) })
    forkModules.set(`${ORIGIN}/host.js`, (scope) => {
      // The in-process harness gives a fork its own scope object, not the real globalThis a real Worker realm would share with thread.ts's Worker class.
      (globalThis as Record<symbol, unknown>)[FORK_LIVENESS_SYMBOL] = (scope as unknown as Record<symbol, unknown>)[FORK_LIVENESS_SYMBOL]
      hosted = new Worker('/loop.js')
      // Otherwise the open IPC channel alone would keep this fork running, and the test would prove nothing about the thread's own ref.
      ;(scope.process as unknown as { disconnect: () => void }).disconnect()
    })
    const child = fork('/host.js')
    let forkExited = false
    // Registered once, up front: the underlying ChildProcess 'exit' only ever fires once, and it may well fire while awaiting terminate() below.
    const exited = new Promise<number | null>((resolve) => { child.once('exit', (code: number | null) => { forkExited = true; resolve(code) }) })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(forkExited).toBe(false)
    await hosted?.terminate()
    expect(await exited).toBe(0)
  })
})
