import { describe, expect, it, vi } from 'vitest'
import {
  initialHistoryState,
  keepNewest,
  recordSent,
  MAX_HISTORY_ENTRIES,
  type HistoryEntry
} from './history.js'
import type { TelemetryPayload } from './disclosure.js'
import { attemptSend, enqueue, initialTransportState, type Clock, type Sender } from './transport.js'

// A payload shape stays fixed across a test; only the period usually
// varies, the way a real caller would advance from month to month.
function payloadFor (period: string): TelemetryPayload {
  return {
    installId: '4c2f2f3a-1111-4444-8888-abcde1234567',
    country: 'IT',
    version: '0.1.0',
    period,
    perApp: { torrent: { activeSec: 90000, backgroundSec: 412000 } }
  }
}

function entryFor (period: string, sentAtMs: number): HistoryEntry {
  return { payload: payloadFor(period), sentAtMs }
}

describe('recordSent -- append-only', () => {
  it('starts empty', () => {
    expect(initialHistoryState.entries).toEqual([])
  })

  it('adds the entry to the end, keeping earlier entries in place', () => {
    const first = recordSent(initialHistoryState, entryFor('2026-08', 1_000))
    const second = recordSent(first, entryFor('2026-09', 2_000))

    expect(second.entries).toEqual([entryFor('2026-08', 1_000), entryFor('2026-09', 2_000)])
  })

  it('does not mutate the state it was given -- the earlier reference is unchanged', () => {
    const first = recordSent(initialHistoryState, entryFor('2026-08', 1_000))
    const firstEntriesRef = first.entries

    recordSent(first, entryFor('2026-09', 2_000))

    expect(first.entries).toBe(firstEntriesRef)
    expect(first.entries).toHaveLength(1)
  })

  it('records the entry exactly as given -- payload and sentAtMs untouched', () => {
    const entry = entryFor('2026-09', 12_345)
    const state = recordSent(initialHistoryState, entry)
    expect(state.entries[0]).toEqual(entry)
  })
})

describe('recordSent -- capped, oldest dropped first', () => {
  it('never exceeds maxEntries: an older entry is evicted to make room for a newer one', () => {
    let state = initialHistoryState
    for (let i = 0; i < 5; i++) {
      state = recordSent(state, entryFor(`2026-0${i + 1}`, i), /* maxEntries */ 3)
    }

    expect(state.entries).toHaveLength(3)
    // The three most recent survive; '2026-01' and '2026-02' were evicted.
    expect(state.entries.map((e) => e.payload.period)).toEqual(['2026-03', '2026-04', '2026-05'])
  })

  it('the default cap (MAX_HISTORY_ENTRIES) applies when no override is given', () => {
    let state = initialHistoryState
    for (let i = 0; i < MAX_HISTORY_ENTRIES + 4; i++) {
      state = recordSent(state, entryFor(`period-${i}`, i))
    }

    expect(state.entries).toHaveLength(MAX_HISTORY_ENTRIES)
    // The oldest four (period-0..period-3) must be gone; the record still
    // ends with the most recent entry appended.
    expect(state.entries[0]?.payload.period).toBe('period-4')
    expect(state.entries[state.entries.length - 1]?.payload.period).toBe(`period-${MAX_HISTORY_ENTRIES + 3}`)
  })

  it('a cap of exactly the current length adds nothing until it grows past it', () => {
    const state = recordSent(initialHistoryState, entryFor('2026-08', 1), 1)
    const capped = recordSent(state, entryFor('2026-09', 2), 1)
    expect(capped.entries).toEqual([entryFor('2026-09', 2)])
  })
})

describe('keepNewest -- the generic helper both this module and transport.ts share', () => {
  it('returns the input unchanged when already within the limit', () => {
    expect(keepNewest([1, 2, 3], 5)).toEqual([1, 2, 3])
  })

  it('drops from the front, keeping the newest `max` items', () => {
    expect(keepNewest([1, 2, 3, 4, 5], 2)).toEqual([4, 5])
  })

  it('a max of 0 keeps nothing', () => {
    expect(keepNewest([1, 2, 3], 0)).toEqual([])
  })
})

// The guarantee the whole module exists for: history is a record of what
// actually left the device, wired to transport.ts's real attemptSend --
// not a hand-rolled stand-in for it. A mutant that recorded the intended
// payload regardless of send outcome would pass every test above (they
// only ever call recordSent directly) but fails here.
describe('integration with transport.ts -- "if a send fails, it is not history"', () => {
  const fixedClock: Clock = () => 1_000

  it('a failed attemptSend produces no history entry', async () => {
    const failing: Sender = vi.fn<Sender>().mockResolvedValue(false)
    const transport = enqueue(initialTransportState, payloadFor('2026-09'), fixedClock)

    const result = await attemptSend(transport, 'accepted', failing, fixedClock)

    expect(result.sent).toBeUndefined()
    const history = result.sent === undefined ? initialHistoryState : recordSent(initialHistoryState, result.sent)
    expect(history.entries).toEqual([])
  })

  it('a refused attemptSend (consent not accepted) produces no history entry either', async () => {
    const neverCalled: Sender = vi.fn<Sender>()
    const transport = enqueue(initialTransportState, payloadFor('2026-09'), fixedClock)

    const result = await attemptSend(transport, 'declined', neverCalled, fixedClock)

    expect(result.sent).toBeUndefined()
    expect(neverCalled).not.toHaveBeenCalled()
  })

  it('a successful attemptSend produces exactly one history entry, matching what was sent', async () => {
    const succeeding: Sender = vi.fn<Sender>().mockResolvedValue(true)
    const transport = enqueue(initialTransportState, payloadFor('2026-09'), fixedClock)

    const result = await attemptSend(transport, 'accepted', succeeding, fixedClock)

    expect(result.sent).toBeDefined()
    const history = result.sent === undefined ? initialHistoryState : recordSent(initialHistoryState, result.sent)
    expect(history.entries).toEqual([{ payload: payloadFor('2026-09'), sentAtMs: 1_000 }])
  })

  it('across several attempts, history contains only the ones that actually succeeded', async () => {
    // Fails, then succeeds -- one attempt each on two different periods.
    const sender: Sender = vi.fn<Sender>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    let transport = enqueue(initialTransportState, payloadFor('2026-08'), fixedClock)
    let history = initialHistoryState

    const first = await attemptSend(transport, 'accepted', sender, fixedClock)
    transport = first.state
    if (first.sent !== undefined) history = recordSent(history, first.sent)

    // Same period is still queued (the failed attempt did not drop it);
    // clear the backoff gate the failure set so the retry is not refused.
    transport = { ...transport, nextAttemptAtMs: undefined }
    const second = await attemptSend(transport, 'accepted', sender, fixedClock)
    transport = second.state
    if (second.sent !== undefined) history = recordSent(history, second.sent)

    expect(history.entries).toEqual([{ payload: payloadFor('2026-08'), sentAtMs: 1_000 }])
  })
})
