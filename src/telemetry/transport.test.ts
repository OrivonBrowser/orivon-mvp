import { describe, expect, it, vi } from 'vitest'
import {
  attemptSend,
  computeBackoffMs,
  enqueue,
  initialTransportState,
  onConsentWithdrawn,
  BASE_BACKOFF_MS,
  IN_FLIGHT_STALE_AFTER_MS,
  MAX_BACKOFF_MS,
  MAX_QUEUE_SIZE,
  type Clock,
  type Sender,
  type TransportState
} from './transport.js'
import type { TelemetryPayload } from './disclosure.js'

function payloadFor (period: string): TelemetryPayload {
  return {
    installId: '4c2f2f3a-1111-4444-8888-abcde1234567',
    country: 'IT',
    version: '0.1.0',
    period,
    perApp: { torrent: { activeSec: 90000, backgroundSec: 412000 } }
  }
}

/** A clock a test can move forward explicitly -- this is what lets the
 *  backoff tests assert exact gating instead of waiting on a real timer. */
function fakeClock (startMs: number): Clock & { advance: (ms: number) => void } {
  let now = startMs
  const clock = (() => now) as Clock & { advance: (ms: number) => void }
  clock.advance = (ms: number) => { now += ms }
  return clock
}

describe('mayTransmit is consulted on every attemptSend call, not cached at startup', () => {
  it('refuses to call the sender when consent is undecided', async () => {
    const sender: Sender = vi.fn<Sender>()
    const state = enqueue(initialTransportState, payloadFor('2026-09'), 'accepted', () => 0)

    const result = await attemptSend(state, 'undecided', sender, () => 0)

    expect(sender).not.toHaveBeenCalled()
    expect(result.sent).toBeUndefined()
    expect(result.state).toBe(state) // nothing changed -- not even attempted
  })

  it('refuses to call the sender when consent is declined', async () => {
    const sender: Sender = vi.fn<Sender>()
    const state = enqueue(initialTransportState, payloadFor('2026-09'), 'accepted', () => 0)

    const result = await attemptSend(state, 'declined', sender, () => 0)

    expect(sender).not.toHaveBeenCalled()
    expect(result.sent).toBeUndefined()
  })

  it('sends when consent is accepted', async () => {
    const sender: Sender = vi.fn<Sender>().mockResolvedValue(true)
    const state = enqueue(initialTransportState, payloadFor('2026-09'), 'accepted', () => 0)

    const result = await attemptSend(state, 'accepted', sender, () => 0)

    expect(sender).toHaveBeenCalledTimes(1)
    expect(result.sent?.payload).toEqual(payloadFor('2026-09'))
  })

  it('a user who opts out mid-session has the backlog purged on the very next attempt -- nothing is grandfathered in', async () => {
    const sender: Sender = vi.fn<Sender>().mockResolvedValue(true)
    let state = enqueue(initialTransportState, payloadFor('2026-09'), 'accepted', () => 0)

    // The payload was queued while accounting was still running under
    // acceptance -- that part is unaffected by a later decline, on
    // purpose (accounting.ts has no notion of consent at all). What must
    // happen the moment the decline is seen is not just "refuse to send
    // this once" but discarding the backlog outright -- otherwise it
    // sits there ready to transmit the instant the user re-enables,
    // which is the privacy hole this test exists to close.
    const result = await attemptSend(state, 'declined', sender, () => 0)

    expect(sender).not.toHaveBeenCalled()
    expect(result.sent).toBeUndefined()
    state = result.state
    expect(state.queue).toHaveLength(0)
    expect(state).toEqual(initialTransportState)
  })

  it('re-enabling consent after a decline sends nothing -- the purge already happened, so there is nothing left to grandfather in', async () => {
    const sender: Sender = vi.fn<Sender>().mockResolvedValue(true)
    let state = enqueue(initialTransportState, payloadFor('2026-07'), 'accepted', () => 0)
    state = enqueue(state, payloadFor('2026-08'), 'accepted', () => 0)

    const declined = await attemptSend(state, 'declined', sender, () => 0)
    state = declined.state

    const reenabled = await attemptSend(state, 'accepted', sender, () => 0)

    expect(sender).not.toHaveBeenCalled()
    expect(reenabled.sent).toBeUndefined()
  })

  it('onConsentWithdrawn is the explicit seam a settings screen can call directly, without waiting for attemptSend', () => {
    let state = enqueue(initialTransportState, payloadFor('2026-07'), 'accepted', () => 0)
    state = enqueue(state, payloadFor('2026-08'), 'accepted', () => 0)

    expect(onConsentWithdrawn(state)).toEqual(initialTransportState)
  })
})

describe('enqueue is gated on consent -- nothing accumulates before a choice is made', () => {
  it('does not stage a payload while consent is undecided', () => {
    const state = enqueue(initialTransportState, payloadFor('2026-09'), 'undecided', () => 0)
    expect(state).toBe(initialTransportState)
  })

  it('does not stage a payload while consent is declined', () => {
    const state = enqueue(initialTransportState, payloadFor('2026-09'), 'declined', () => 0)
    expect(state).toBe(initialTransportState)
  })

  it('stages a payload once consent is accepted', () => {
    const state = enqueue(initialTransportState, payloadFor('2026-09'), 'accepted', () => 0)
    expect(state.queue).toHaveLength(1)
  })
})

describe('batching -- attemptSend only ever accepts a whole TelemetryPayload, never a raw event', () => {
  it('an empty queue is a safe no-op: the sender is never called', async () => {
    const sender: Sender = vi.fn<Sender>()
    const result = await attemptSend(initialTransportState, 'accepted', sender, () => 0)

    expect(sender).not.toHaveBeenCalled()
    expect(result.sent).toBeUndefined()
    expect(result.state).toBe(initialTransportState)
  })

  it('sends the oldest queued payload first (FIFO)', async () => {
    const sender: Sender = vi.fn<Sender>().mockResolvedValue(true)
    let state = enqueue(initialTransportState, payloadFor('2026-07'), 'accepted', () => 0)
    state = enqueue(state, payloadFor('2026-08'), 'accepted', () => 0)
    state = enqueue(state, payloadFor('2026-09'), 'accepted', () => 0)

    const result = await attemptSend(state, 'accepted', sender, () => 0)

    expect(sender).toHaveBeenCalledWith(payloadFor('2026-07'))
    expect(result.state.queue.map((q) => q.payload.period)).toEqual(['2026-08', '2026-09'])
  })

  it('re-enqueuing the same period replaces the stale entry instead of duplicating it', () => {
    const stale = payloadFor('2026-09')
    const fresh: TelemetryPayload = { ...stale, perApp: { torrent: { activeSec: 999999, backgroundSec: 0 } } }

    let state = enqueue(initialTransportState, stale, 'accepted', () => 0)
    state = enqueue(state, fresh, 'accepted', () => 0)

    expect(state.queue).toHaveLength(1)
    expect(state.queue[0]?.payload).toEqual(fresh)
  })

  it('sends exactly one payload per attemptSend call, even with several queued', async () => {
    const sender: Sender = vi.fn<Sender>().mockResolvedValue(true)
    let state = enqueue(initialTransportState, payloadFor('2026-07'), 'accepted', () => 0)
    state = enqueue(state, payloadFor('2026-08'), 'accepted', () => 0)

    const result = await attemptSend(state, 'accepted', sender, () => 0)

    expect(sender).toHaveBeenCalledTimes(1)
    expect(result.state.queue).toHaveLength(1) // the second payload is still waiting
  })
})

describe('re-enqueuing an already-queued period replaces it in place -- FIFO order is not disturbed', () => {
  it('preserves queue order when the oldest period is refreshed with updated totals', () => {
    let state = enqueue(initialTransportState, payloadFor('2026-07'), 'accepted', () => 0)
    state = enqueue(state, payloadFor('2026-08'), 'accepted', () => 0)

    const refreshed: TelemetryPayload = { ...payloadFor('2026-07'), perApp: { torrent: { activeSec: 1, backgroundSec: 2 } } }
    state = enqueue(state, refreshed, 'accepted', () => 0)

    // Before the fix, filter-then-append moved the refreshed 2026-07 to
    // the back, so the queue read ['2026-08', '2026-07'] -- the opposite
    // of the FIFO order the earlier test in this file already asserts.
    expect(state.queue.map((q) => q.payload.period)).toEqual(['2026-07', '2026-08'])
    expect(state.queue[0]?.payload).toEqual(refreshed)
  })

  it('a refresh does not let the queue cap evict a newer period from the front', () => {
    let state = enqueue(initialTransportState, payloadFor('2026-07'), 'accepted', () => 0, /* maxQueueSize */ 2)
    state = enqueue(state, payloadFor('2026-08'), 'accepted', () => 0, 2)

    // Repeatedly refreshing the OLDEST period must not push it to the
    // back and then off the front -- that would silently evict 2026-08,
    // the newer period, which is the opposite of "keeping the most
    // recent periods" enqueue's own doc comment promises.
    for (let i = 0; i < 3; i++) {
      state = enqueue(state, payloadFor('2026-07'), 'accepted', () => 0, 2)
    }

    expect(state.queue.map((q) => q.payload.period)).toEqual(['2026-07', '2026-08'])
  })
})

describe('enqueue resets a stale backoff when the resulting head is a different payload', () => {
  it('a fresh period landing at an empty queue starts with no backoff, even after the previous head failed repeatedly and was evicted', async () => {
    const failing: Sender = vi.fn<Sender>().mockResolvedValue(false)
    const clock = fakeClock(0)
    let state = enqueue(initialTransportState, payloadFor('2026-07'), 'accepted', clock, /* maxQueueSize */ 1)

    for (let i = 0; i < 4; i++) {
      const result = await attemptSend(state, 'accepted', failing, clock)
      state = result.state
      clock.advance(MAX_BACKOFF_MS + 1) // clear the backoff gate before the next attempt
    }
    expect(state.failureCount).toBe(4)
    expect(state.nextAttemptAtMs).toBeDefined()

    // A different period arrives; with maxQueueSize 1 it evicts 2026-07
    // outright, so the new head never earned any of the numbers above.
    state = enqueue(state, payloadFor('2026-09'), 'accepted', clock, 1)

    expect(state.queue.map((q) => q.payload.period)).toEqual(['2026-09'])
    expect(state.failureCount).toBe(0)
    expect(state.nextAttemptAtMs).toBeUndefined()
  })

  it('does not reset the backoff when the head is refreshed rather than replaced by a different period', async () => {
    const failing: Sender = vi.fn<Sender>().mockResolvedValue(false)
    const clock = fakeClock(0)
    let state = enqueue(initialTransportState, payloadFor('2026-09'), 'accepted', clock)

    const result = await attemptSend(state, 'accepted', failing, clock)
    state = result.state
    expect(state.failureCount).toBe(1)

    // Same period, updated totals -- still logically the same queued
    // item, so the backoff it already earned should carry over.
    const refreshed: TelemetryPayload = { ...payloadFor('2026-09'), perApp: { torrent: { activeSec: 1, backgroundSec: 1 } } }
    state = enqueue(state, refreshed, 'accepted', clock)

    expect(state.failureCount).toBe(1)
    expect(state.nextAttemptAtMs).toBeDefined()
  })
})

describe('the queue cap -- a long offline period does not accumulate unbounded', () => {
  it('never exceeds MAX_QUEUE_SIZE: enqueuing past it drops the oldest, not the newest', () => {
    let state = initialTransportState
    for (let i = 0; i < MAX_QUEUE_SIZE + 5; i++) {
      state = enqueue(state, payloadFor(`period-${i}`), 'accepted', () => 0)
    }

    expect(state.queue.length).toBeLessThanOrEqual(MAX_QUEUE_SIZE)
    expect(state.queue).toHaveLength(MAX_QUEUE_SIZE)
    const periods = state.queue.map((q) => q.payload.period)
    // The most recent MAX_QUEUE_SIZE periods survive.
    expect(periods).toEqual([`period-${MAX_QUEUE_SIZE + 2}`, `period-${MAX_QUEUE_SIZE + 3}`, `period-${MAX_QUEUE_SIZE + 4}`])
  })

  it('respects an explicit override, for a caller (or a test) that wants a smaller cap', () => {
    let state = initialTransportState
    for (let i = 0; i < 6; i++) {
      state = enqueue(state, payloadFor(`period-${i}`), 'accepted', () => 0, /* maxQueueSize */ 2)
    }

    expect(state.queue).toHaveLength(2)
    expect(state.queue.map((q) => q.payload.period)).toEqual(['period-4', 'period-5'])
  })

  it('a queue that never drains while offline still stays bounded across repeated failed attempts', async () => {
    const alwaysFails: Sender = vi.fn<Sender>().mockResolvedValue(false)
    const clock = fakeClock(0)
    let state = initialTransportState

    for (let i = 0; i < MAX_QUEUE_SIZE + 3; i++) {
      state = enqueue(state, payloadFor(`period-${i}`), 'accepted', clock)
      const result = await attemptSend(state, 'accepted', alwaysFails, clock)
      state = result.state
      clock.advance(MAX_BACKOFF_MS + 1) // clear backoff so the next enqueue's attempt is not gated out
    }

    expect(state.queue.length).toBeLessThanOrEqual(MAX_QUEUE_SIZE)
  })
})

describe('retry with backoff', () => {
  it('computeBackoffMs is 0 before any failure', () => {
    expect(computeBackoffMs(0)).toBe(0)
    expect(computeBackoffMs(-1)).toBe(0)
  })

  it('computeBackoffMs doubles with each consecutive failure', () => {
    expect(computeBackoffMs(1)).toBe(BASE_BACKOFF_MS)
    expect(computeBackoffMs(2)).toBe(BASE_BACKOFF_MS * 2)
    expect(computeBackoffMs(3)).toBe(BASE_BACKOFF_MS * 4)
  })

  it('computeBackoffMs never exceeds MAX_BACKOFF_MS, however many failures', () => {
    expect(computeBackoffMs(100)).toBe(MAX_BACKOFF_MS)
  })

  it('a failed send leaves the payload queued, sets a backoff gate, and increments failureCount', async () => {
    const failing: Sender = vi.fn<Sender>().mockResolvedValue(false)
    const clock = fakeClock(1_000)
    const state = enqueue(initialTransportState, payloadFor('2026-09'), 'accepted', clock)

    const result = await attemptSend(state, 'accepted', failing, clock)

    expect(result.sent).toBeUndefined()
    expect(result.state.queue).toHaveLength(1) // not dropped
    expect(result.state.failureCount).toBe(1)
    expect(result.state.nextAttemptAtMs).toBe(1_000 + BASE_BACKOFF_MS)
  })

  it('a second attempt before the backoff gate opens does not call the sender again', async () => {
    const failing: Sender = vi.fn<Sender>().mockResolvedValue(false)
    const clock = fakeClock(0)
    let state = enqueue(initialTransportState, payloadFor('2026-09'), 'accepted', clock)

    const first = await attemptSend(state, 'accepted', failing, clock)
    state = first.state
    clock.advance(1) // still well inside the backoff window

    const second = await attemptSend(state, 'accepted', failing, clock)

    expect(failing).toHaveBeenCalledTimes(1) // not called on the second, gated attempt
    expect(second.sent).toBeUndefined()
    expect(second.state).toBe(state) // untouched -- refused before the sender was even considered
  })

  it('once the backoff window elapses, the next attempt calls the sender again and backs off further on a second failure', async () => {
    const failing: Sender = vi.fn<Sender>().mockResolvedValue(false)
    const clock = fakeClock(0)
    let state = enqueue(initialTransportState, payloadFor('2026-09'), 'accepted', clock)

    const first = await attemptSend(state, 'accepted', failing, clock)
    state = first.state
    clock.advance(BASE_BACKOFF_MS + 1) // gate now open

    const second = await attemptSend(state, 'accepted', failing, clock)

    expect(failing).toHaveBeenCalledTimes(2)
    expect(second.state.failureCount).toBe(2)
    expect(second.state.nextAttemptAtMs).toBe(clock() + BASE_BACKOFF_MS * 2)
  })

  it('a subsequent success resets failureCount and the backoff gate, and removes the item from the queue', async () => {
    const sender: Sender = vi.fn<Sender>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const clock = fakeClock(0)
    let state = enqueue(initialTransportState, payloadFor('2026-09'), 'accepted', clock)

    const first = await attemptSend(state, 'accepted', sender, clock)
    state = first.state
    clock.advance(BASE_BACKOFF_MS + 1)

    const second = await attemptSend(state, 'accepted', sender, clock)

    expect(second.sent?.payload).toEqual(payloadFor('2026-09'))
    expect(second.state.queue).toEqual([])
    expect(second.state.failureCount).toBe(0)
    expect(second.state.nextAttemptAtMs).toBeUndefined()
  })
})

describe('an in-flight guard stops two overlapping attemptSend calls from double-sending the same payload', () => {
  it('a second attemptSend given the same state while the first is still awaiting the sender is refused, not doubled', async () => {
    const sender: Sender = vi.fn<Sender>().mockResolvedValue(true)
    const state = enqueue(initialTransportState, payloadFor('2026-09'), 'accepted', () => 0)

    const [first, second] = await Promise.all([
      attemptSend(state, 'accepted', sender, () => 0),
      attemptSend(state, 'accepted', sender, () => 0)
    ])

    expect(sender).toHaveBeenCalledTimes(1)
    const sent = [first, second].filter((r) => r.sent !== undefined)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.sent?.payload).toEqual(payloadFor('2026-09'))
  })

  it('a stale in-flight marker left behind by a crash mid-send does not wedge the queue forever', async () => {
    const sender: Sender = vi.fn<Sender>().mockResolvedValue(true)
    let state = enqueue(initialTransportState, payloadFor('2026-09'), 'accepted', () => 0)
    // Simulate a persisted state loaded back after a crash mid-send: the
    // marker survived the restart, but so much time has passed that it
    // can only be a leftover, never a genuinely still-running attempt.
    state = { ...state, inFlightSince: 0 }
    const clock = fakeClock(IN_FLIGHT_STALE_AFTER_MS + 1)

    const result = await attemptSend(state, 'accepted', sender, clock)

    expect(sender).toHaveBeenCalledTimes(1)
    expect(result.sent).toBeDefined()
  })

  it('a fresh (non-stale) in-flight marker refuses the attempt outright', async () => {
    const sender: Sender = vi.fn<Sender>().mockResolvedValue(true)
    let state = enqueue(initialTransportState, payloadFor('2026-09'), 'accepted', () => 0)
    state = { ...state, inFlightSince: 0 }
    const clock = fakeClock(IN_FLIGHT_STALE_AFTER_MS - 1)

    const result = await attemptSend(state, 'accepted', sender, clock)

    expect(sender).not.toHaveBeenCalled()
    expect(result.sent).toBeUndefined()
  })
})

describe('never block the app -- a Sender that throws is treated as a failure, not a crash', () => {
  it('a synchronously-throwing Sender does not reject attemptSend', async () => {
    const throwing: Sender = vi.fn(() => { throw new Error('network stack blew up') })
    const clock = fakeClock(500)
    const state = enqueue(initialTransportState, payloadFor('2026-09'), 'accepted', clock)

    await expect(attemptSend(state, 'accepted', throwing, clock)).resolves.toBeDefined()
    const result = await attemptSend(state, 'accepted', throwing, clock)

    expect(result.sent).toBeUndefined()
    expect(result.state.failureCount).toBe(1)
    expect(result.state.queue).toHaveLength(1)
  })

  it('a Sender whose promise rejects does not reject attemptSend either', async () => {
    const rejecting: Sender = vi.fn<Sender>().mockRejectedValue(new Error('timeout'))
    const clock = fakeClock(500)
    const state = enqueue(initialTransportState, payloadFor('2026-09'), 'accepted', clock)

    const result = await attemptSend(state, 'accepted', rejecting, clock)

    expect(result.sent).toBeUndefined()
    expect(result.state.failureCount).toBe(1)
  })
})

// Sanity check that TransportState really is plain, replayable data --
// the same property accounting.ts's AccountingState relies on -- so a
// caller can persist it between attempts the way session state is
// persisted elsewhere in this directory.
describe('TransportState is inert data', () => {
  it('round-trips through JSON unchanged', () => {
    const state: TransportState = enqueue(initialTransportState, payloadFor('2026-09'), 'accepted', () => 42)
    const roundTripped = JSON.parse(JSON.stringify(state)) as TransportState
    expect(roundTripped).toEqual(state)
  })
})
