import { afterEach, describe, expect, it, vi } from 'vitest'
import { LIMITS } from '../../../contracts/index.js'
import { IN_FLIGHT_QUEUE_LIMIT, IN_FLIGHT_WAIT_MS } from '../in-flight.js'
import { APP, TCP_GRANT, acquireSocket, never, outcomeNow, rejection, table } from './handles.test-helpers.js'

// Past LIMITS.inFlightOperations an operation WAITS, briefly and in a bounded
// queue, for a slot, the way Node queues work behind its own thread pool,
// instead of failing with 'limit'. Only a full queue or an expired wait
// refuses.

function fill (t: ReturnType<typeof table>, handleId: string, count: number): Array<() => void> {
  const finishers: Array<() => void> = []
  for (let i = 0; i < count; i += 1) {
    void t.run(APP, { on: 'handle', handleId }, async () => { await new Promise<void>((resolve) => { finishers.push(resolve) }) }).catch(() => {})
  }
  return finishers
}

afterEach(() => { vi.useRealTimers() })

describe('the in-flight cap queues briefly instead of refusing', () => {
  it('an operation past the cap waits, and runs once a slot frees', async () => {
    const t = table()
    const handle = acquireSocket(t)
    const finishers = fill(t, handle.id, LIMITS.inFlightOperations)
    const work = vi.fn(async () => 'ran')

    const waiting = t.run(APP, { on: 'handle', handleId: handle.id }, work)
    expect((await outcomeNow(waiting)).state).toBe('pending')
    expect(work).not.toHaveBeenCalled()

    finishers[0]?.()
    await expect(waiting).resolves.toBe('ran')
    expect(t.counts(APP).inFlight).toBe(LIMITS.inFlightOperations - 1)
  })

  it('never runs more than the cap at once', async () => {
    const t = table()
    const handle = acquireSocket(t)
    fill(t, handle.id, LIMITS.inFlightOperations + 10)
    await outcomeNow(Promise.resolve())

    expect(t.counts(APP).inFlight).toBe(LIMITS.inFlightOperations)
  })

  it('refuses at once, without running, once the queue itself is full', async () => {
    const t = table()
    const handle = acquireSocket(t)
    fill(t, handle.id, LIMITS.inFlightOperations + IN_FLIGHT_QUEUE_LIMIT)
    const work = vi.fn(async () => 'ran')

    const outcome = await outcomeNow(t.run(APP, { on: 'handle', handleId: handle.id }, work))

    expect(outcome.state === 'rejected' ? outcome.error.code : outcome.state).toBe('limit')
    expect(work).not.toHaveBeenCalled()
  })

  it('refuses with limit once the wait itself runs out', async () => {
    vi.useFakeTimers()
    const t = table()
    const handle = acquireSocket(t)
    fill(t, handle.id, LIMITS.inFlightOperations)

    const waiting = t.run(APP, { on: 'handle', handleId: handle.id }, never)
    const assertion = expect(waiting).rejects.toMatchObject({ code: 'limit' })
    await vi.advanceTimersByTimeAsync(IN_FLIGHT_WAIT_MS + 1)
    await assertion
  })

  it('a waiting operation is cancelled by a revoke, and holds no slot afterwards', async () => {
    const t = table()
    const handle = acquireSocket(t)
    const finishers = fill(t, handle.id, LIMITS.inFlightOperations)
    const waiting = t.run(APP, { on: 'grant', grantId: TCP_GRANT }, never)

    await t.revoke(APP, TCP_GRANT)
    expect((await rejection(waiting)).code).toBe('revoked')

    for (const finish of finishers) finish()
    await outcomeNow(Promise.resolve())
    expect(t.counts(APP).inFlight).toBe(0)
  })
})
