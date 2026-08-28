import { describe, expect, it, vi } from 'vitest'
import {
  attemptSend,
  computeBackoffMs,
  enqueue,
  initialTransportState,
  BASE_BACKOFF_MS,
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
    const state = enqueue(initialTransportState, payloadFor('2026-09'), () => 0)

    const result = await attemptSend(state, 'undecided', sender, () => 0)

    expect(sender).not.toHaveBeenCalled()
    expect(result.sent).toBeUndefined()
    expect(result.state).toBe(state) // nothing changed -- not even attempted
  })

  it('refuses to call the sender when consent is declined', async () => {
    const sender: Sender = vi.fn<Sender>()
    const state = enqueue(initialTransportState, payloadFor('2026-09'), () => 0)

    const result = await attemptSend(state, 'declined', sender, () => 0)

    expect(sender).not.toHaveBeenCalled()
    expect(result.sent).toBeUndefined()
  })

  it('sends when consent is accepted', async () => {
    const sender: Sender = vi.fn<Sender>().mockResolvedValue(true)
    const state = enqueue(initialTransportState, payloadFor('2026-09'), () => 0)

    const result = await attemptSend(state, 'accepted', sender, () => 0)

    expect(sender).toHaveBeenCalledTimes(1)
    expect(result.sent?.payload).toEqual(payloadFor('2026-09'))
  })

  it('a user who opts out mid-session stops being sent on the very next attempt -- the queued item is not grandfathered in', async () => {
    const sender: Sender = vi.fn<Sender>().mockResolvedValue(true)
    let state = enqueue(initialTransportState, payloadFor('2026-09'), () => 0)

    // The payload was queued while accounting was still running under
    // acceptance -- that part is unaffected by a later decline, on
    // purpose (accounting.ts has no notion of consent at all). What must
    // change is whether attemptSend will ever put it on the wire: called
    // with 'declined', it must refuse, exactly as it would have refused
    // an 'undecided' caller above -- consent is re-checked here, not
    // assumed from whatever it was when the payload was queued.
    const result = await attemptSend(state, 'declined', sender, () => 0)

    expect(sender).not.toHaveBeenCalled()
    expect(result.sent).toBeUndefined()
    state = result.state
    expect(state.queue).toHaveLength(1) // still queued, simply never sent
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
    let state = enqueue(initialTransportState, payloadFor('2026-07'), () => 0)
    state = enqueue(state, payloadFor('2026-08'), () => 0)
    state = enqueue(state, payloadFor('2026-09'), () => 0)

    const result = await attemptSend(state, 'accepted', sender, () => 0)

    expect(sender).toHaveBeenCalledWith(payloadFor('2026-07'))
    expect(result.state.queue.map((q) => q.payload.period)).toEqual(['2026-08', '2026-09'])
  })

  it('re-enqueuing the same period replaces the stale entry instead of duplicating it', () => {
    const stale = payloadFor('2026-09')
    const fresh: TelemetryPayload = { ...stale, perApp: { torrent: { activeSec: 999999, backgroundSec: 0 } } }

    let state = enqueue(initialTransportState, stale, () => 0)
    state = enqueue(state, fresh, () => 0)

    expect(state.queue).toHaveLength(1)
    expect(state.queue[0]?.payload).toEqual(fresh)
  })

  it('sends exactly one payload per attemptSend call, even with several queued', async () => {
    const sender: Sender = vi.fn<Sender>().mockResolvedValue(true)
    let state = enqueue(initialTransportState, payloadFor('2026-07'), () => 0)
    state = enqueue(state, payloadFor('2026-08'), () => 0)

    const result = await attemptSend(state, 'accepted', sender, () => 0)

    expect(sender).toHaveBeenCalledTimes(1)
    expect(result.state.queue).toHaveLength(1) // the second payload is still waiting
  })
})

describe('the queue cap -- a long offline period does not accumulate unbounded', () => {
  it('never exceeds MAX_QUEUE_SIZE: enqueuing past it drops the oldest, not the newest', () => {
    let state = initialTransportState
    for (let i = 0; i < MAX_QUEUE_SIZE + 5; i++) {
      state = enqueue(state, payloadFor(`period-${i}`), () => 0)
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
      state = enqueue(state, payloadFor(`period-${i}`), () => 0, /* maxQueueSize */ 2)
    }

    expect(state.queue).toHaveLength(2)
    expect(state.queue.map((q) => q.payload.period)).toEqual(['period-4', 'period-5'])
  })

  it('a queue that never drains while offline still stays bounded across repeated failed attempts', async () => {
    const alwaysFails: Sender = vi.fn<Sender>().mockResolvedValue(false)
    const clock = fakeClock(0)
    let state = initialTransportState

    for (let i = 0; i < MAX_QUEUE_SIZE + 3; i++) {
      state = enqueue(state, payloadFor(`period-${i}`), clock)
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
    const state = enqueue(initialTransportState, payloadFor('2026-09'), clock)

    const result = await attemptSend(state, 'accepted', failing, clock)

    expect(result.sent).toBeUndefined()
    expect(result.state.queue).toHaveLength(1) // not dropped
    expect(result.state.failureCount).toBe(1)
    expect(result.state.nextAttemptAtMs).toBe(1_000 + BASE_BACKOFF_MS)
  })

  it('a second attempt before the backoff gate opens does not call the sender again', async () => {
    const failing: Sender = vi.fn<Sender>().mockResolvedValue(false)
    const clock = fakeClock(0)
    let state = enqueue(initialTransportState, payloadFor('2026-09'), clock)

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
    let state = enqueue(initialTransportState, payloadFor('2026-09'), clock)

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
    let state = enqueue(initialTransportState, payloadFor('2026-09'), clock)

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

describe('never block the app -- a Sender that throws is treated as a failure, not a crash', () => {
  it('a synchronously-throwing Sender does not reject attemptSend', async () => {
    const throwing: Sender = vi.fn(() => { throw new Error('network stack blew up') })
    const clock = fakeClock(500)
    const state = enqueue(initialTransportState, payloadFor('2026-09'), clock)

    await expect(attemptSend(state, 'accepted', throwing, clock)).resolves.toBeDefined()
    const result = await attemptSend(state, 'accepted', throwing, clock)

    expect(result.sent).toBeUndefined()
    expect(result.state.failureCount).toBe(1)
    expect(result.state.queue).toHaveLength(1)
  })

  it('a Sender whose promise rejects does not reject attemptSend either', async () => {
    const rejecting: Sender = vi.fn<Sender>().mockRejectedValue(new Error('timeout'))
    const clock = fakeClock(500)
    const state = enqueue(initialTransportState, payloadFor('2026-09'), clock)

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
    const state: TransportState = enqueue(initialTransportState, payloadFor('2026-09'), () => 42)
    const roundTripped = JSON.parse(JSON.stringify(state)) as TransportState
    expect(roundTripped).toEqual(state)
  })
})
