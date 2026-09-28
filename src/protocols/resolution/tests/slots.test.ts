import { describe, expect, it } from 'vitest'
import { Slots } from '../slots.js'

/** Resolves once `task()` has genuinely been entered, so a test can tell
 * "still queued" from "running" without a real timer. */
function deferred<T> (): { promise: Promise<T>, resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('Slots', () => {
  it('runs up to the limit at once, and queues the rest', async () => {
    const slots = new Slots(2)
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()]
    const order: number[] = []
    const runs = gates.map((gate, i) => slots.run(async () => { order.push(i); await gate.promise }))

    await Promise.resolve() // let the first two tasks actually start
    expect(order).toEqual([0, 1])

    gates[0]!.resolve()
    await runs[0]
    await Promise.resolve()
    expect(order).toEqual([0, 1, 2])

    gates[1]!.resolve()
    gates[2]!.resolve()
    await Promise.all(runs)
  })

  it('never lets more than `limit` tasks run at once, even under a burst of releases', async () => {
    const slots = new Slots(3)
    let active = 0
    let peak = 0
    const task = async (): Promise<void> => {
      active++
      peak = Math.max(peak, active)
      await Promise.resolve()
      await Promise.resolve()
      active--
    }
    await Promise.all(Array.from({ length: 20 }, async () => await slots.run(task)))
    expect(peak).toBeLessThanOrEqual(3)
  })

  it('hands a freed slot to the longest-waiting caller first', async () => {
    const slots = new Slots(1)
    const gate = deferred<void>()
    const order: number[] = []
    const first = slots.run(async () => { await gate.promise })
    const second = slots.run(async () => { order.push(2) })
    const third = slots.run(async () => { order.push(3) })

    gate.resolve()
    await first
    await second
    await third
    expect(order).toEqual([2, 3])
  })

  it('a queued caller aborts out of the queue, rejecting with the signal reason, without ever running', async () => {
    const slots = new Slots(1)
    const gate = deferred<void>()
    const holder = slots.run(async () => { await gate.promise })
    const controller = new AbortController()
    let ran = false
    const queued = slots.run(async () => { ran = true }, controller.signal)

    controller.abort(new Error('gave up'))
    await expect(queued).rejects.toThrow('gave up')

    gate.resolve()
    await holder
    expect(ran).toBe(false)
  })

  it('rejects immediately for a signal that is already aborted', async () => {
    const slots = new Slots(1)
    const controller = new AbortController()
    controller.abort(new Error('already gone'))
    await expect(slots.run(async () => {}, controller.signal)).rejects.toThrow('already gone')
  })

  it('an aborted waiter does not leave a gap: the next real waiter still gets the slot', async () => {
    const slots = new Slots(1)
    const gate = deferred<void>()
    const holder = slots.run(async () => { await gate.promise })
    const controller = new AbortController()
    const aborted = slots.run(async () => {}, controller.signal)
    let secondRan = false
    const second = slots.run(async () => { secondRan = true })

    controller.abort(new Error('gone'))
    await expect(aborted).rejects.toThrow()

    gate.resolve()
    await holder
    await second
    expect(secondRan).toBe(true)
  })

  // The bug this fixes: a released slot was briefly counted as free (active--
  // then the waiter's OWN active++ only ran a microtask later, once its await
  // resumed), so a brand-new run() call arriving in that window could take the
  // slot a queued waiter was waiting for, and both would then hold it at once.
  it('a released slot never lets a brand-new caller run alongside the waiter it was meant for', async () => {
    const slots = new Slots(1)
    const gate = deferred<void>()
    let concurrent = 0
    let sawTwoAtOnce = false
    const track = async (): Promise<void> => {
      concurrent++
      if (concurrent > 1) sawTwoAtOnce = true
      await Promise.resolve()
      concurrent--
    }
    const holder = slots.run(async () => { await gate.promise; await track() })
    const waiter = slots.run(track)
    gate.resolve()
    await holder
    // A caller arriving right as the slot is released -- the same moment a
    // pre-fix implementation would have let both run at once.
    const newcomer = slots.run(track)
    await Promise.all([waiter, newcomer])
    expect(sawTwoAtOnce).toBe(false)
  })
})
