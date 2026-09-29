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
import { hasChildHost } from '../host-client.js'
import { Worker } from '../thread.js'
import { failNext, forkModules, threadModules, workers } from './support/in-process-worker.js'

vi.mock('../../worker/launch.js', async () => ({ createChildWorker: (await import('./support/in-process-worker.js')).createInProcessWorker }))
// Wraps the real function (never fakes it) so a call to it is still observable: the point is
// that a thread's own launchChild() call never reaches it at all -- `viaHost: false` short-
// circuits before `hasChildHost()` would ever run (F1's structural check replaced the old,
// cached `hostConnection()` this test used to spy on).
vi.mock('../host-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../host-client.js')>()
  return { ...actual, hasChildHost: vi.fn(actual.hasChildHost) }
})

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
  failNext.worker = false
  failNext.postMessage = false
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

  it('exposes stdout and stderr as Readables even when neither option is set, as Node\'s Worker always does', async () => {
    threadModules.set(`${ORIGIN}/quiet-io.js`, (scope) => { threadGlobals(scope).parentPort.on('message', () => {}) })
    const worker = new Worker('/quiet-io.js')
    expect(worker.stdout).not.toBeNull()
    expect(worker.stderr).not.toBeNull()
    expect(worker.stdin).toBeNull()
    await worker.terminate()
  })

  it('throws DataCloneError synchronously from the constructor for workerData structured clone cannot carry, as Node\'s does', () => {
    let caught: unknown
    try {
      const worker = new Worker('/x.js', { workerData: { onDone () {} } })
      void worker
    } catch (error) {
      caught = error
    }
    expect((caught as { name?: string } | undefined)?.name).toBe('DataCloneError')
  })

  it('does not reject workerData over a port that is also named in transferList: the port is real and transferable, not something to clone', async () => {
    const { port1, port2 } = new MessageChannel()
    threadModules.set(`${ORIGIN}/take-port.js`, (scope) => { threadGlobals(scope).parentPort.on('message', () => {}) })
    let worker: Worker | undefined
    expect(() => { worker = new Worker('/take-port.js', { workerData: { port: port2 }, transferList: [port2] }) }).not.toThrow()
    await worker?.terminate()
    port1.close()
  })

  it('never leaks the Worker when the real send to it fails after construction already succeeded', async () => {
    failNext.postMessage = true
    threadModules.set(`${ORIGIN}/never-runs.js`, () => {})
    const worker = new Worker('/never-runs.js')
    const errored = new Promise((resolve) => worker.once('error', resolve))
    await errored
    expect(workers.at(-1)?.terminated).toBe(true)
  })

  it('never asks whether a child host exists to start: launchChild\'s viaHost:false short-circuits before hasChildHost() for a thread', async () => {
    threadModules.set(`${ORIGIN}/local-only.js`, (scope) => { threadGlobals(scope).parentPort.on('message', () => {}) })
    const worker = new Worker('/local-only.js')
    await new Promise((resolve) => worker.once('online', resolve))
    expect(hasChildHost).not.toHaveBeenCalled()
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

  it('releases a forked child\'s liveness ref even when the thread inside it never starts, since \'close\' fires but \'exit\' never does for a failed start', async () => {
    forkModules.set(`${ORIGIN}/host-failed-thread.js`, (scope) => {
      (globalThis as Record<symbol, unknown>)[FORK_LIVENESS_SYMBOL] = (scope as unknown as Record<symbol, unknown>)[FORK_LIVENESS_SYMBOL]
      failNext.worker = true
      const doomed = new Worker('/never-runs.js')
      doomed.on('error', () => {})
      ;(scope.process as unknown as { disconnect: () => void }).disconnect()
    })
    const child = fork('/host-failed-thread.js')
    const exited = new Promise<number | null>((resolve) => { child.once('exit', (code: number | null) => { resolve(code) }) })
    expect(await exited).toBe(0)
  })

  it('does not resurrect a forked child\'s liveness ref by calling ref() after the thread has already exited, as Node\'s ref() post-exit is a no-op', async () => {
    let hosted: Worker | undefined
    threadModules.set(`${ORIGIN}/quick.js`, (scope) => { threadGlobals(scope).parentPort.on('message', () => {}) })
    forkModules.set(`${ORIGIN}/host-late-ref.js`, (scope) => {
      (globalThis as Record<symbol, unknown>)[FORK_LIVENESS_SYMBOL] = (scope as unknown as Record<symbol, unknown>)[FORK_LIVENESS_SYMBOL]
      hosted = new Worker('/quick.js')
      ;(scope.process as unknown as { disconnect: () => void }).disconnect()
    })
    const child = fork('/host-late-ref.js')
    const exited = new Promise<number | null>((resolve) => { child.once('exit', (code: number | null) => { resolve(code) }) })
    // The fork's own module runs on a later microtask than fork() itself returns, the same as the
    // sibling test above: without this wait, `hosted` is still undefined and `hosted?.terminate()`
    // silently no-ops instead of actually exercising it.
    await vi.waitFor(() => { expect(hosted).toBeDefined() })
    await hosted?.terminate()
    hosted?.ref()
    expect(await exited).toBe(0)
  })
})
