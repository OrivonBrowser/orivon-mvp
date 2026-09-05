import { describe, expect, it } from 'vitest'
import { hasQueuedOrigin, withOriginQueue } from './origin-queue.js'

/** A deferred promise -- lets a test control exactly when a queued task settles, so it can prove ordering rather than merely observing whatever the event loop happens to do. */
function deferred<T> (): { promise: Promise<T>, resolve: (value: T) => void, reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('withOriginQueue', () => {
  it('runs a single task and returns its result', async () => {
    const result = await withOriginQueue('https://a.example', async () => 42)
    expect(result).toBe(42)
  })

  it('propagates a task\'s rejection to the caller, not just a generic failure', async () => {
    await expect(withOriginQueue('https://a.example', async () => { throw new Error('boom') }))
      .rejects.toThrow('boom')
  })

  it('serializes two calls for the SAME origin -- the second does not start until the first settles', async () => {
    const order: string[] = []
    const first = deferred<void>()

    const call1 = withOriginQueue('https://a.example', async () => {
      order.push('1 start')
      await first.promise
      order.push('1 end')
    })
    const call2 = withOriginQueue('https://a.example', async () => {
      order.push('2 start')
    })

    // Give call2 every chance to start early if the queue were not actually
    // serializing -- a microtask flush without resolving `first` yet.
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['1 start'])

    first.resolve()
    await call1
    await call2

    expect(order).toEqual(['1 start', '1 end', '2 start'])
  })

  it('runs calls for DIFFERENT origins concurrently -- one origin never waits on another', async () => {
    const order: string[] = []
    const first = deferred<void>()

    const callA = withOriginQueue('https://a.example', async () => {
      order.push('a start')
      await first.promise
      order.push('a end')
    })
    const callB = withOriginQueue('https://b.example', async () => {
      order.push('b start')
    })

    await callB
    expect(order).toEqual(['a start', 'b start'])

    first.resolve()
    await callA
    expect(order).toEqual(['a start', 'b start', 'a end'])
  })

  it('a rejected task does not block the next queued task for the same origin', async () => {
    const order: string[] = []

    const call1 = withOriginQueue('https://a.example', async () => {
      order.push('1')
      throw new Error('boom')
    })
    const call2 = withOriginQueue('https://a.example', async () => {
      order.push('2')
    })

    await expect(call1).rejects.toThrow('boom')
    await call2
    expect(order).toEqual(['1', '2'])
  })

  it('three calls for the same origin run in strict call order, not completion order', async () => {
    const order: number[] = []
    const delays = [30, 10, 20]

    const calls = delays.map((ms, index) =>
      withOriginQueue('https://a.example', async () => {
        await new Promise((resolve) => setTimeout(resolve, ms))
        order.push(index)
      })
    )

    await Promise.all(calls)
    expect(order).toEqual([0, 1, 2])
  })

  it('drops the origin\'s queue entry once every chained task for it has drained', async () => {
    const origin = 'https://drains.example'
    expect(hasQueuedOrigin(origin)).toBe(false)

    const call = withOriginQueue(origin, async () => 'done')
    expect(hasQueuedOrigin(origin)).toBe(true)

    await call
    // Cleanup runs in a microtask chained off settlement, not synchronously
    // with it -- give it a few turns of the microtask queue.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(hasQueuedOrigin(origin)).toBe(false)
  })

  it('a call\'s cleanup must not evict a NEWER call\'s still-in-flight entry (guarded delete, not naive)', async () => {
    const origin = 'https://guarded.example'
    const order: string[] = []
    const firstDone = deferred<void>()
    const secondStarted = deferred<void>()
    const secondDone = deferred<void>()

    const call1 = withOriginQueue(origin, async () => {
      order.push('1 start')
      await firstDone.promise
      order.push('1 end')
    })
    const call2 = withOriginQueue(origin, async () => {
      order.push('2 start')
      secondStarted.resolve()
      await secondDone.promise
      order.push('2 end')
    })

    firstDone.resolve()
    // Waits until call2's task has actually started -- which can only
    // happen after call1's whole chain (and therefore call1's cleanup,
    // registered earlier on the same settlement) has already run.
    await secondStarted.promise
    expect(order).toEqual(['1 start', '1 end', '2 start'])

    // A third call arrives while call2 is still in flight. If call1's
    // cleanup deleted the map entry NAIVELY (unconditionally, rather than
    // only when it is still the current one), this call would find no
    // queue for the origin at all and run immediately -- interleaving with
    // call2, which is exactly the A62 hazard this file exists to prevent.
    const call3 = withOriginQueue(origin, async () => {
      order.push('3 start')
    })

    // Give call3 every chance to start early if the guard were missing.
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['1 start', '1 end', '2 start'])

    secondDone.resolve()
    await call1
    await call2
    await call3

    expect(order).toEqual(['1 start', '1 end', '2 start', '2 end', '3 start'])
  })

  it('throws instead of deadlocking when a task calls withOriginQueue again for its own origin', async () => {
    const origin = 'https://reentrant.example'

    const outer = withOriginQueue(origin, async () => {
      await withOriginQueue(origin, async () => {
        // Never reached: the re-entrant call must be rejected before this runs.
      })
    })

    await expect(outer).rejects.toThrow(/re-entrant/i)
  }, 2000)
})
