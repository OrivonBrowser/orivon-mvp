import { describe, expect, it } from 'vitest'
import { createFetchGate } from '../fetch-gate.js'

/** Lets every already-queued promise callback run. */
async function flush (): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** A promise's outcome so far, read without awaiting it. */
function track<T> (promise: Promise<T>): { settled: boolean, value: T | undefined } {
  const state: { settled: boolean, value: T | undefined } = { settled: false, value: undefined }
  void promise.then((value) => { state.settled = true; state.value = value })
  return state
}

/** `count` requests enqueued at once, each with its admission tracked. */
function enqueueMany (gate: ReturnType<typeof createFetchGate>, count: number): Array<{ id: number, admitted: { settled: boolean } }> {
  return Array.from({ length: count }, () => {
    const id = gate.enqueue()
    return { id, admitted: track(gate.admitted(id)) }
  })
}

describe('createFetchGate -- before any refusal', () => {
  it('admits every request at once, as a browser multiplexing over HTTP/2 would', async () => {
    const gate = createFetchGate()
    const requests = enqueueMany(gate, 100)
    await flush()
    expect(requests.every((r) => r.admitted.settled)).toBe(true)
  })
})

describe('createFetchGate -- after the broker refuses a dial for the origin\'s socket allowance', () => {
  it('lets the refused request retry once another request finishes', async () => {
    const gate = createFetchGate()
    const [a, b] = enqueueMany(gate, 2)
    const retry = track(gate.afterLimit(b!.id))
    await flush()
    expect(retry.settled).toBe(false)
    gate.release(a!.id)
    await flush()
    expect(retry.value).toBe(true)
  })

  it('holds the tab to the number of requests still live, and queues the rest in order', async () => {
    const gate = createFetchGate()
    const burst = enqueueMany(gate, 4)
    void gate.afterLimit(burst[3]!.id)
    const later = enqueueMany(gate, 2)
    await flush()
    expect(later.map((r) => r.admitted.settled)).toEqual([false, false])

    gate.release(burst[3]!.id)
    gate.release(burst[0]!.id)
    await flush()
    expect(later.map((r) => r.admitted.settled)).toEqual([true, false])
  })

  it('hands a freed socket to a request already waiting for one before admitting a queued one', async () => {
    const gate = createFetchGate()
    const burst = enqueueMany(gate, 3)
    const retry = track(gate.afterLimit(burst[2]!.id))
    const queued = enqueueMany(gate, 1)[0]!
    gate.release(burst[0]!.id)
    await flush()
    expect(retry.value).toBe(true)
    expect(queued.admitted.settled).toBe(false)

    gate.release(burst[1]!.id)
    await flush()
    expect(queued.admitted.settled).toBe(true)
  })

  it('answers false at once when no other request is live to free a socket', async () => {
    const gate = createFetchGate()
    const [only] = enqueueMany(gate, 1)
    expect(await gate.afterLimit(only!.id)).toBe(false)
  })

  it('answers false to every waiter once the last live request is itself refused, so none waits forever', async () => {
    const gate = createFetchGate()
    const [a, b] = enqueueMany(gate, 2)
    const first = track(gate.afterLimit(a!.id))
    await flush()
    expect(first.settled).toBe(false)
    expect(await gate.afterLimit(b!.id)).toBe(false)
    await flush()
    expect(first.value).toBe(false)
  })

  it('forgets what it learned once idle, since whatever held the allowance may have let go', async () => {
    const gate = createFetchGate()
    const burst = enqueueMany(gate, 2)
    void gate.afterLimit(burst[1]!.id)
    gate.release(burst[1]!.id)
    gate.release(burst[0]!.id)
    const next = enqueueMany(gate, 10)
    await flush()
    expect(next.every((r) => r.admitted.settled)).toBe(true)
  })
})

describe('createFetchGate -- release', () => {
  it('withdraws a queued request without it ever taking a place', async () => {
    const gate = createFetchGate()
    const burst = enqueueMany(gate, 3)
    void gate.afterLimit(burst[2]!.id)
    gate.release(burst[2]!.id)
    const [withdrawn, next] = enqueueMany(gate, 2)
    gate.release(withdrawn!.id)
    gate.release(burst[0]!.id)
    await flush()
    expect(next!.admitted.settled).toBe(true)
  })

  it('frees one place however many times the same ticket is released', async () => {
    const gate = createFetchGate()
    const burst = enqueueMany(gate, 3)
    void gate.afterLimit(burst[2]!.id)
    gate.release(burst[2]!.id)
    const queued = enqueueMany(gate, 2)
    gate.release(burst[0]!.id)
    gate.release(burst[0]!.id)
    await flush()
    expect(queued.map((q) => q.admitted.settled)).toEqual([true, false])
  })
})
