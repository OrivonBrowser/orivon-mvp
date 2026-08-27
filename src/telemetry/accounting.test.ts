import { describe, expect, it } from 'vitest'
import {
  applyEvent,
  fold,
  initialState,
  totalsFor,
  DEFAULT_IDLE_TIMEOUT_MS,
  type AccountingState,
  type TelemetryEvent
} from './accounting.js'

// Every scenario below picks a fixed UTC instant with Date.UTC(...) rather
// than Date.now() -- the whole point of the fold is that it needs no clock,
// so the tests supply exact timestamps and assert exact totals, never
// "greater than zero". A passing assertion like that would not have caught
// the bug this module exists to prevent (mvp-scope.md's corrected Success
// metric section): background time silently counted as active.

describe('session start/stop: background accrual with no focus', () => {
  const app = 'torrent'
  const t0 = Date.UTC(2026, 8, 1, 0, 0, 0)

  it('accrues backgroundSec, not activeSec, for a session that is never focused', () => {
    const events: TelemetryEvent[] = [
      { kind: 'session-start', atMs: t0, app },
      { kind: 'session-stop', atMs: t0 + 120_000, app } // 2 minutes
    ]
    const state = fold(events)
    expect(totalsFor(state, app, '2026-09')).toEqual({ activeSec: 0, backgroundSec: 120 })
  })

  it('a stop with no matching start is a safe no-op, not a crash', () => {
    const state = fold([{ kind: 'session-stop', atMs: t0, app }])
    expect(totalsFor(state, app, '2026-09')).toEqual({ activeSec: 0, backgroundSec: 0 })
    expect(state.openSessions).toEqual({})
  })

  it('focusing an app that never started a session accrues nothing to it', () => {
    const events: TelemetryEvent[] = [
      { kind: 'focus', atMs: t0, app: 'ghost' },
      { kind: 'interaction', atMs: t0 },
      { kind: 'checkpoint', atMs: t0 + 5_000 }
    ]
    const state = fold(events)
    expect(state.perApp).toEqual({})
  })
})

describe('focus + interaction: active accrual', () => {
  const app = 'torrent'
  const t0 = Date.UTC(2026, 8, 1, 0, 0, 0)

  it('requires BOTH focus and a prior interaction -- focus alone stays background', () => {
    const events: TelemetryEvent[] = [
      { kind: 'session-start', atMs: t0, app },
      { kind: 'focus', atMs: t0, app },
      // no interaction event at all
      { kind: 'session-stop', atMs: t0 + 60_000, app }
    ]
    const state = fold(events)
    expect(totalsFor(state, app, '2026-09')).toEqual({ activeSec: 0, backgroundSec: 60 })
  })

  it('focused and interacted with counts fully as active, within the idle timeout', () => {
    const events: TelemetryEvent[] = [
      { kind: 'session-start', atMs: t0, app },
      { kind: 'focus', atMs: t0, app },
      { kind: 'interaction', atMs: t0 },
      { kind: 'session-stop', atMs: t0 + 60_000, app }
    ]
    const state = fold(events)
    expect(totalsFor(state, app, '2026-09')).toEqual({ activeSec: 60, backgroundSec: 0 })
  })

  it('interaction while no app is focused accrues to nobody', () => {
    const events: TelemetryEvent[] = [
      { kind: 'session-start', atMs: t0, app },
      { kind: 'interaction', atMs: t0 }, // never focused
      { kind: 'session-stop', atMs: t0 + 10_000, app }
    ]
    const state = fold(events)
    expect(totalsFor(state, app, '2026-09')).toEqual({ activeSec: 0, backgroundSec: 10 })
  })
})

describe('idle timeout', () => {
  const app = 'torrent'
  const t0 = Date.UTC(2026, 8, 1, 0, 0, 0)
  const idleTimeoutMs = 5_000

  it('active accrual stops at the idle deadline; the rest of the focused span is background', () => {
    const events: TelemetryEvent[] = [
      { kind: 'session-start', atMs: t0, app },
      { kind: 'focus', atMs: t0, app },
      { kind: 'interaction', atMs: t0 },
      { kind: 'session-stop', atMs: t0 + 12_000, app } // 12s, idle timeout is 5s
    ]
    const state = fold(events, initialState, idleTimeoutMs)
    // active for [0,5000), background for [5000,12000) -- split inside a
    // single event gap, not just at event boundaries.
    expect(totalsFor(state, app, '2026-09')).toEqual({ activeSec: 5, backgroundSec: 7 })
  })

  it('a fresh interaction pushes the idle deadline out instead of letting it lapse', () => {
    const events: TelemetryEvent[] = [
      { kind: 'session-start', atMs: t0, app },
      { kind: 'focus', atMs: t0, app },
      { kind: 'interaction', atMs: t0 },
      { kind: 'interaction', atMs: t0 + 3_000 }, // before the first deadline (5000)
      { kind: 'session-stop', atMs: t0 + 8_000, app } // deadline is now 3000+5000=8000
    ]
    const state = fold(events, initialState, idleTimeoutMs)
    expect(totalsFor(state, app, '2026-09')).toEqual({ activeSec: 8, backgroundSec: 0 })
  })

  it('DEFAULT_IDLE_TIMEOUT_MS is used when no override is passed', () => {
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBeGreaterThan(0)
    const events: TelemetryEvent[] = [
      { kind: 'session-start', atMs: t0, app },
      { kind: 'focus', atMs: t0, app },
      { kind: 'interaction', atMs: t0 },
      { kind: 'session-stop', atMs: t0 + 1_000, app }
    ]
    // 1s span is well inside any sane default idle timeout.
    expect(totalsFor(fold(events), app, '2026-09')).toEqual({ activeSec: 1, backgroundSec: 0 })
  })
})

describe('tab switch', () => {
  const t0 = Date.UTC(2026, 8, 1, 0, 0, 0)

  it('switching focus moves who CAN be active but does not transfer freshness of interaction', () => {
    const events: TelemetryEvent[] = [
      { kind: 'session-start', atMs: t0, app: 'a' },
      { kind: 'session-start', atMs: t0, app: 'b' },
      { kind: 'focus', atMs: t0, app: 'a' },
      { kind: 'interaction', atMs: t0 },
      { kind: 'focus', atMs: t0 + 5_000, app: 'b' }, // tab switch, no fresh interaction
      { kind: 'session-stop', atMs: t0 + 15_000, app: 'a' },
      { kind: 'session-stop', atMs: t0 + 15_000, app: 'b' }
    ]
    const state = fold(events, initialState, 300_000) // idle timeout large enough to be a non-factor
    // 'a': active while focused+interacted [0,5000), then background once
    // the switch happens, even though the idle timeout has not elapsed --
    // it is simply not focused any more.
    expect(totalsFor(state, 'a', '2026-09')).toEqual({ activeSec: 5, backgroundSec: 10 })
    // 'b': background before the switch (open, not focused), and STILL
    // background after it -- focus moved to 'b' but no one has interacted
    // with 'b' yet, so it cannot be "active" no matter how long it holds
    // focus. This is the assertion that would fail if focus alone (without
    // the idle-clock reset in `refocus`) were treated as activity.
    expect(totalsFor(state, 'b', '2026-09')).toEqual({ activeSec: 0, backgroundSec: 15 })
  })

  it('an interaction after the switch does make the newly-focused app active', () => {
    const events: TelemetryEvent[] = [
      { kind: 'session-start', atMs: t0, app: 'a' },
      { kind: 'session-start', atMs: t0, app: 'b' },
      { kind: 'focus', atMs: t0, app: 'a' },
      { kind: 'interaction', atMs: t0 },
      { kind: 'focus', atMs: t0 + 5_000, app: 'b' },
      { kind: 'interaction', atMs: t0 + 5_000 }, // fresh interaction with 'b'
      { kind: 'session-stop', atMs: t0 + 15_000, app: 'a' },
      { kind: 'session-stop', atMs: t0 + 15_000, app: 'b' }
    ]
    const state = fold(events, initialState, 300_000)
    // 'b' was already open (but unfocused) for the first 5s, same as the
    // previous test -- that part is still background. Only the span after
    // the switch, now with a fresh interaction, is active.
    expect(totalsFor(state, 'b', '2026-09')).toEqual({ activeSec: 10, backgroundSec: 5 })
  })
})

describe('suspend/resume', () => {
  const app = 'torrent'
  const t0 = Date.UTC(2026, 8, 1, 0, 0, 0)

  it('a suspended interval contributes to neither activeSec nor backgroundSec, for anyone', () => {
    const events: TelemetryEvent[] = [
      { kind: 'session-start', atMs: t0, app },
      { kind: 'focus', atMs: t0, app },
      { kind: 'interaction', atMs: t0 },
      { kind: 'suspend', atMs: t0 + 2_000 },
      { kind: 'resume', atMs: t0 + 9_000 }, // 7s asleep
      { kind: 'session-stop', atMs: t0 + 10_000, app }
    ]
    const state = fold(events, initialState, 5_000)
    // [0,2000) active (interacted at 0, idle deadline 5000).
    // [2000,9000) suspended: excluded entirely, even though part of it
    // would otherwise still have been inside the idle window.
    // [9000,10000) background: real wall-clock time has moved past the
    // idle deadline (5000) by the time the machine wakes back up, so this
    // is NOT active just because the suspend itself was short.
    expect(totalsFor(state, app, '2026-09')).toEqual({ activeSec: 2, backgroundSec: 1 })
    // Elapsed 10s total: 2 accounted + 1 accounted + 7 suspended = 10.
  })

  it('backgroundSec keeps accruing across a suspend/resume for an unfocused session', () => {
    const events: TelemetryEvent[] = [
      { kind: 'session-start', atMs: t0, app }, // never focused
      { kind: 'suspend', atMs: t0 + 1_000 },
      { kind: 'resume', atMs: t0 + 4_000 },
      { kind: 'session-stop', atMs: t0 + 6_000, app }
    ]
    const state = fold(events)
    // [0,1000) + [4000,6000) = 3s background; [1000,4000) suspended = excluded.
    expect(totalsFor(state, app, '2026-09')).toEqual({ activeSec: 0, backgroundSec: 3 })
  })
})

describe('multiple concurrent sessions of the same app (e.g. two tabs)', () => {
  const app = 'torrent'
  const t0 = Date.UTC(2026, 8, 1, 0, 0, 0)

  it('stays open, and keeps accruing, until the LAST of two open sessions stops', () => {
    const events: TelemetryEvent[] = [
      { kind: 'session-start', atMs: t0, app }, // tab 1
      { kind: 'session-start', atMs: t0, app }, // tab 2
      { kind: 'session-stop', atMs: t0 + 60_000, app }, // tab 1 closes; tab 2 still open
      { kind: 'session-stop', atMs: t0 + 180_000, app } // tab 2 closes; now truly stopped
    ]
    const state = fold(events)
    // Accrual must continue through the first stop -- undercounting here
    // (stopping at the first close) is exactly the "biases downward" risk
    // this module is judged against.
    expect(totalsFor(state, app, '2026-09')).toEqual({ activeSec: 0, backgroundSec: 180 })
    expect(state.openSessions).toEqual({})
  })

  it('a duplicate start does not create a phantom third session', () => {
    const events: TelemetryEvent[] = [
      { kind: 'session-start', atMs: t0, app },
      { kind: 'session-start', atMs: t0, app },
      { kind: 'session-stop', atMs: t0 + 30_000, app },
      { kind: 'session-stop', atMs: t0 + 30_000, app }
    ]
    const state = fold(events)
    expect(state.openSessions).toEqual({})
    expect(totalsFor(state, app, '2026-09')).toEqual({ activeSec: 0, backgroundSec: 30 })
  })
})

describe('month rollover', () => {
  const app = 'torrent'

  it('splits a background interval spanning a UTC month boundary across both periods', () => {
    const t0 = Date.UTC(2026, 7, 31, 23, 0, 0) // 2026-08-31T23:00:00Z
    const t1 = Date.UTC(2026, 8, 1, 2, 0, 0) // 2026-09-01T02:00:00Z (+3h: 1h Aug, 2h Sep)
    const state = fold([
      { kind: 'session-start', atMs: t0, app },
      { kind: 'session-stop', atMs: t1, app }
    ])
    expect(totalsFor(state, app, '2026-08')).toEqual({ activeSec: 0, backgroundSec: 3_600 })
    expect(totalsFor(state, app, '2026-09')).toEqual({ activeSec: 0, backgroundSec: 7_200 })
  })

  it('splits an ACTIVE interval spanning a UTC month boundary the same way', () => {
    const t0 = Date.UTC(2026, 7, 31, 23, 0, 0)
    const t1 = Date.UTC(2026, 8, 1, 2, 0, 0)
    const state = fold([
      { kind: 'session-start', atMs: t0, app },
      { kind: 'focus', atMs: t0, app },
      { kind: 'interaction', atMs: t0 },
      { kind: 'session-stop', atMs: t1, app }
    ], initialState, 4 * 60 * 60 * 1000) // idle timeout longer than the whole span
    expect(totalsFor(state, app, '2026-08')).toEqual({ activeSec: 3_600, backgroundSec: 0 })
    expect(totalsFor(state, app, '2026-09')).toEqual({ activeSec: 7_200, backgroundSec: 0 })
  })

  it('does not depend on a checkpoint landing near the boundary', () => {
    const t0 = Date.UTC(2026, 7, 31, 23, 0, 0)
    const t1 = Date.UTC(2026, 8, 1, 2, 0, 0)
    const withCheckpoint = fold([
      { kind: 'session-start', atMs: t0, app },
      { kind: 'checkpoint', atMs: t0 + 30 * 60 * 1000 }, // well before midnight
      { kind: 'session-stop', atMs: t1, app }
    ])
    const withoutCheckpoint = fold([
      { kind: 'session-start', atMs: t0, app },
      { kind: 'session-stop', atMs: t1, app }
    ])
    expect(totalsFor(withCheckpoint, app, '2026-08')).toEqual(totalsFor(withoutCheckpoint, app, '2026-08'))
    expect(totalsFor(withCheckpoint, app, '2026-09')).toEqual(totalsFor(withoutCheckpoint, app, '2026-09'))
  })

  it('rolls a year over correctly (December to January)', () => {
    const t0 = Date.UTC(2026, 11, 31, 23, 30, 0) // 2026-12-31T23:30:00Z
    const t1 = Date.UTC(2027, 0, 1, 0, 30, 0) // 2027-01-01T00:30:00Z (+1h)
    const state = fold([
      { kind: 'session-start', atMs: t0, app },
      { kind: 'session-stop', atMs: t1, app }
    ])
    expect(totalsFor(state, app, '2026-12')).toEqual({ activeSec: 0, backgroundSec: 1_800 })
    expect(totalsFor(state, app, '2027-01')).toEqual({ activeSec: 0, backgroundSec: 1_800 })
  })
})

describe('abnormal termination is bounded by checkpoints, not by session length', () => {
  const app = 'torrent'
  const t0 = Date.UTC(2026, 8, 1, 0, 0, 0)

  it('with no checkpoints at all, a crash loses the entire open session', () => {
    // Only a start ever gets processed -- nothing tells the fold that any
    // time passed afterward, so nothing is accrued. This is the failure
    // mode periodic checkpoints exist to bound.
    const state = fold([{ kind: 'session-start', atMs: t0, app }])
    expect(totalsFor(state, app, '2026-09')).toEqual({ activeSec: 0, backgroundSec: 0 })
  })

  it('periodic checkpoints bound the loss to the time since the last one', () => {
    const upToLastCheckpoint: TelemetryEvent[] = [
      { kind: 'session-start', atMs: t0, app },
      { kind: 'checkpoint', atMs: t0 + 60_000 },
      { kind: 'checkpoint', atMs: t0 + 120_000 },
      { kind: 'checkpoint', atMs: t0 + 180_000 }
    ]
    // Simulated crash: the stream just ends here, no session-stop.
    const crashed = fold(upToLastCheckpoint)
    // A clean stop at the exact instant of the last checkpoint.
    const clean = fold([...upToLastCheckpoint, { kind: 'session-stop', atMs: t0 + 180_000, app }])

    expect(totalsFor(crashed, app, '2026-09')).toEqual({ activeSec: 0, backgroundSec: 180 })
    // The crash accounts for exactly as much as a clean stop at the same
    // instant would have. What is lost is bounded by the checkpoint
    // interval (whatever happened after t0+180000), not by how long the
    // session had already been running.
    expect(totalsFor(crashed, app, '2026-09')).toEqual(totalsFor(clean, app, '2026-09'))
  })
})

describe('out-of-order input is defused, not propagated', () => {
  const app = 'torrent'
  const t0 = Date.UTC(2026, 8, 1, 0, 0, 0)

  it('an event timestamped before the last-settled instant accrues nothing and does not move the anchor backward', () => {
    const events: TelemetryEvent[] = [
      { kind: 'session-start', atMs: t0, app },
      { kind: 'checkpoint', atMs: t0 + 1_000 },
      { kind: 'checkpoint', atMs: t0 + 500 }, // time travel
      { kind: 'checkpoint', atMs: t0 + 2_000 }
    ]
    const state = fold(events)
    // If the out-of-order event corrupted the anchor (e.g. moved it back
    // to 500), the final checkpoint would double-count part of [500,1000)
    // and this would read 2.5, not 2.
    expect(totalsFor(state, app, '2026-09')).toEqual({ activeSec: 0, backgroundSec: 2 })
  })
})

describe('totalsFor', () => {
  it('returns zeroed totals, not undefined, for an app/period with no accrual', () => {
    expect(totalsFor(initialState, 'nonexistent', '2026-09')).toEqual({ activeSec: 0, backgroundSec: 0 })
  })
})

describe('fold', () => {
  it('is exactly events.reduce(applyEvent, seed) with the same idle timeout threaded through', () => {
    const app = 'torrent'
    const t0 = Date.UTC(2026, 8, 1, 0, 0, 0)
    const events: TelemetryEvent[] = [
      { kind: 'session-start', atMs: t0, app },
      { kind: 'focus', atMs: t0, app },
      { kind: 'interaction', atMs: t0 },
      { kind: 'session-stop', atMs: t0 + 4_000, app }
    ]
    const idleTimeoutMs = 2_000
    const viaFold = fold(events, initialState, idleTimeoutMs)
    let viaManualReduce: AccountingState = initialState
    for (const event of events) viaManualReduce = applyEvent(viaManualReduce, event, idleTimeoutMs)
    expect(viaFold).toEqual(viaManualReduce)
  })

  it('resumes correctly from a non-initial seed, e.g. a state reloaded after restart', () => {
    const app = 'torrent'
    const t0 = Date.UTC(2026, 8, 1, 0, 0, 0)
    const afterFirstHalf = fold([
      { kind: 'session-start', atMs: t0, app },
      { kind: 'checkpoint', atMs: t0 + 60_000 }
    ])
    // Simulates a fresh process reloading a persisted checkpoint and
    // continuing to fold new events onto it.
    const final = fold(
      [{ kind: 'session-stop', atMs: t0 + 90_000, app }],
      afterFirstHalf
    )
    expect(totalsFor(final, app, '2026-09')).toEqual({ activeSec: 0, backgroundSec: 90 })
  })
})
