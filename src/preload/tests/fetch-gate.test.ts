import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFetchGate, FETCH_GATE_PROBE_MS } from '../fetch-gate.js'

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

describe('createFetchGate -- probing, for a socket freed where the gate cannot see it', () => {
  afterEach(() => { vi.useRealTimers() })

  it('retries the oldest refused request after a probe interval, though no routed request has finished', async () => {
    vi.useFakeTimers()
    const gate = createFetchGate()
    const [hung, refused] = enqueueMany(gate, 2)
    const retry = track(gate.afterLimit(refused!.id))
    await vi.advanceTimersByTimeAsync(FETCH_GATE_PROBE_MS - 1)
    expect(retry.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(retry.value).toBe(true)
    gate.release(hung!.id)
  })

  it('admits a queued request on a probe once nobody is waiting, so a low ceiling does not outlive the refusal that set it', async () => {
    vi.useFakeTimers()
    const gate = createFetchGate()
    const [hung, refused] = enqueueMany(gate, 2)
    void gate.afterLimit(refused!.id)
    gate.release(refused!.id)
    const queued = enqueueMany(gate, 2)
    await vi.advanceTimersByTimeAsync(FETCH_GATE_PROBE_MS)
    expect(queued.map((q) => q.admitted.settled)).toEqual([true, false])
    await vi.advanceTimersByTimeAsync(FETCH_GATE_PROBE_MS)
    expect(queued.map((q) => q.admitted.settled)).toEqual([true, true])
    gate.release(hung!.id)
  })

  it('settles back to what is live when a probe is refused again', async () => {
    vi.useFakeTimers()
    const gate = createFetchGate()
    const [hung, refused] = enqueueMany(gate, 2)
    void gate.afterLimit(refused!.id)
    await vi.advanceTimersByTimeAsync(FETCH_GATE_PROBE_MS)
    void gate.afterLimit(refused!.id)
    const queued = enqueueMany(gate, 1)[0]!
    await flush()
    expect(queued.admitted.settled).toBe(false)
    gate.release(hung!.id)
  })

  it('keeps a probe refused again at the head of the line, not behind requests refused after it', async () => {
    vi.useFakeTimers()
    const gate = createFetchGate()
    const burst = enqueueMany(gate, 4)
    void gate.afterLimit(burst[2]!.id)
    const later = track(gate.afterLimit(burst[3]!.id))
    await vi.advanceTimersByTimeAsync(FETCH_GATE_PROBE_MS)
    const probed = track(gate.afterLimit(burst[2]!.id))
    gate.release(burst[0]!.id)
    await flush()
    expect(probed.value).toBe(true)
    expect(later.settled).toBe(false)
    gate.release(burst[1]!.id)
  })

  it('stops probing once nothing waits', async () => {
    vi.useFakeTimers()
    const gate = createFetchGate()
    const [a, b] = enqueueMany(gate, 2)
    void gate.afterLimit(b!.id)
    gate.release(b!.id)
    gate.release(a!.id)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('createFetchGate -- what a withdrawn request leaves behind', () => {
  it('hands a freed socket past a refused request that has since gone, to the next one waiting', async () => {
    const gate = createFetchGate()
    const burst = enqueueMany(gate, 3)
    void gate.afterLimit(burst[1]!.id)
    const second = track(gate.afterLimit(burst[2]!.id))
    gate.release(burst[1]!.id)
    gate.release(burst[0]!.id)
    await flush()
    expect(second.value).toBe(true)
  })

  it('settles the promises it handed out, since each one is held across contextBridge', async () => {
    const gate = createFetchGate()
    const burst = enqueueMany(gate, 2)
    const retry = track(gate.afterLimit(burst[1]!.id))
    const queued = enqueueMany(gate, 1)[0]!
    gate.release(queued.id)
    gate.release(burst[1]!.id)
    await flush()
    expect(queued.admitted.settled).toBe(true)
    expect(retry.value).toBe(false)
    gate.release(burst[0]!.id)
  })
})
