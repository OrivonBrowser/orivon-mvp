// A pure fold over a stream of telemetry events, producing accumulated
// session time. No I/O, no timers, no Date.now() -- every event carries its
// own timestamp (`atMs`, epoch milliseconds), which is what makes this
// testable without a clock: feed a fixed array of events, assert exact
// totals.
//
// WHY a fold and not a running total kept some other way: the accounted
// state at any point is a deterministic function of the events processed so
// far, so a caller can replay a persisted event log, or resume from a
// persisted AccountingState snapshot, and get identical numbers either way.
// See docs/development/testing.md SS6 and src/telemetry/README.md.
//
// THE SPLIT THIS FILE EXISTS FOR: `activeSec` (focused AND interacted with,
// within an idle timeout) and `backgroundSec` (running but not that) are
// separate numbers, and the project's success metric is stated on
// `activeSec` alone (ADR-0004, mvp-scope.md SS"Success metric"). A torrent
// seeds in the background by design; counting that as "active" is the bug
// that made the metric satisfiable by a user who left after one magnet
// link. Every subtlety below exists to not reintroduce that bug in either
// direction -- undercounting activeSec makes a real success look like a
// failure, overcounting makes a failure look like a success -- and both
// directions are covered in accounting.test.ts.
//
// ARCHITECTURE: `applyEvent` is an incremental reducer meant to run one event
// at a time in the real collector, with the caller persisting AccountingState
// (I/O, deliberately outside this file) periodically -- so a crash loses at
// most the time since the last processed event. `checkpoint` exists purely to
// give the caller a place to inject that persistence during otherwise-silent
// stretches -- e.g. a torrent seeding for hours with no focus change. See the
// "no checkpoint on crash" tests.

export type AppId = string

/**
 * A UTC calendar month, `'YYYY-MM'`. Matches the `period` field of the
 * ADR-0004 payload.
 *
 * UTC, not local time: this module has no ambient timezone and must be
 * deterministic on any machine. Bucketing by local time would make the
 * same event stream roll over at a different moment on a CI runner than on
 * a user's machine, which is exactly the kind of nondeterminism a pure
 * fold is supposed to rule out.
 */
export type Period = string

export interface PeriodTotals {
  readonly activeSec: number
  readonly backgroundSec: number
}

type PerApp = Readonly<Record<AppId, Readonly<Record<Period, PeriodTotals>>>>
type OpenSessions = Readonly<Record<AppId, number>>

export type TelemetryEvent =
  | { readonly kind: 'session-start'; readonly atMs: number; readonly app: AppId }
  | { readonly kind: 'session-stop'; readonly atMs: number; readonly app: AppId }
  | { readonly kind: 'focus'; readonly atMs: number; readonly app: AppId }
  | { readonly kind: 'blur'; readonly atMs: number }
  | { readonly kind: 'interaction'; readonly atMs: number }
  | { readonly kind: 'suspend'; readonly atMs: number }
  | { readonly kind: 'resume'; readonly atMs: number }
  | { readonly kind: 'checkpoint'; readonly atMs: number }

export interface AccountingState {
  readonly perApp: PerApp
  /** Open session count per app, not a boolean. Two tabs running the same
   *  app overlap into one open session that only closes when the last of
   *  them stops -- see the "second tab keeps it open" test. */
  readonly openSessions: OpenSessions
  readonly focusedApp: AppId | undefined
  readonly lastInteractionAt: number | undefined
  readonly suspended: boolean
  /** The instant accrual is settled up to. undefined before the first
   *  event: there is nothing to accrue *from* yet. */
  readonly lastAccountedAt: number | undefined
}

export const initialState: AccountingState = {
  perApp: {},
  openSessions: {},
  focusedApp: undefined,
  lastInteractionAt: undefined,
  suspended: false,
  lastAccountedAt: undefined
}

/**
 * No document in the corpus sets this figure (checked: mvp-scope.md,
 * ADR-0004, open-questions.md all describe the SHAPE of "active" -- focused
 * and interacted with -- but not a duration). Five minutes is a judgment
 * call, picked to match common OS idle-detection defaults; flagged here
 * rather than silently assumed. It is a parameter, not a hardcoded
 * constant, so tuning it later does not touch this file.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000

// Exported for callers outside this file that need the same 'YYYY-MM' UTC
// bucketing -- e.g. building a DisclosureMeta.period for "the current
// period" -- so that logic has exactly one implementation
// (code-guidelines.md Rule 3), not a second copy next to whoever needs it.
export function periodOf (ms: number): Period {
  const d = new Date(ms)
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${d.getUTCFullYear()}-${month}`
}

function startOfNextUtcMonth (ms: number): number {
  const d = new Date(ms)
  // Date.UTC overflows month 12 into January of the next year on its own,
  // so a December event rolls into '<year+1>-01' with no special case.
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0)
}

/**
 * Splits [fromMs, toMs) into one slice per UTC calendar month it touches.
 *
 * This is what stops a single long-running interval from either dumping
 * its whole duration into one period or dropping the part on the far side
 * of midnight on the 1st. It runs on every settle, unconditionally --
 * correctness does not depend on a checkpoint happening to land near the
 * boundary.
 */
function monthSlices (fromMs: number, toMs: number): ReadonlyArray<{ readonly start: number; readonly end: number; readonly period: Period }> {
  const slices: Array<{ start: number; end: number; period: Period }> = []
  let cursor = fromMs
  while (cursor < toMs) {
    const end = Math.min(startOfNextUtcMonth(cursor), toMs)
    slices.push({ start: cursor, end, period: periodOf(cursor) })
    cursor = end
  }
  return slices
}

/** Adds `seconds` to one (app, period, bucket) cell. Kept as exact
 *  fractional seconds throughout -- never rounded here -- so many small
 *  accruals cannot compound into a rounding-driven undercount. Rounding
 *  for the wire payload (ADR-0004 shows integers) is a serialization
 *  concern for whatever later builds that payload, not this module's. */
function credit (perApp: PerApp, app: AppId, period: Period, bucket: keyof PeriodTotals, seconds: number): PerApp {
  if (seconds <= 0) return perApp // defensive: callers already guard for positivity
  const appTotals = perApp[app] ?? {}
  const periodTotals = appTotals[period] ?? { activeSec: 0, backgroundSec: 0 }
  return {
    ...perApp,
    [app]: {
      ...appTotals,
      [period]: { ...periodTotals, [bucket]: periodTotals[bucket] + seconds }
    }
  }
}

function withOpenSession (sessions: OpenSessions, app: AppId): OpenSessions {
  return { ...sessions, [app]: (sessions[app] ?? 0) + 1 }
}

/**
 * Only removes the key once the count reaches zero, so a second tab of the
 * same app keeps it open when the first one closes ('session-stop' fires
 * once per tab, not once per app). A stop with no matching start is a
 * no-op, not an error -- telemetry must never be the reason a real bug
 * becomes a crash.
 */
function withoutOpenSession (sessions: OpenSessions, app: AppId): OpenSessions {
  const count = sessions[app]
  if (count === undefined) return sessions
  if (count > 1) return { ...sessions, [app]: count - 1 }
  const next = { ...sessions }
  delete next[app]
  return next
}

/**
 * Changes focus and, only on an actual change, forgets prior interaction.
 *
 * WHY: without this, activity in the tab the user just left would make the
 * newly-focused tab look "active" before they have touched anything in it
 * -- overcounting activeSec the same way the original durationSec metric
 * overcounted by not distinguishing focus at all (mvp-scope.md's
 * corrected Success metric section). Re-asserting focus on the app that
 * already has it (a duplicate event) is not a change and must not cost the
 * user their in-progress idle window.
 */
function refocus (state: AccountingState, nextFocusedApp: AppId | undefined): AccountingState {
  if (state.focusedApp === nextFocusedApp) return state
  return { ...state, focusedApp: nextFocusedApp, lastInteractionAt: undefined }
}

/**
 * Accrues elapsed time from `state.lastAccountedAt` up to `t` into
 * whatever is currently open, then moves the anchor to `t`. Called at the
 * top of every applyEvent, before that event's own effect is applied -- so
 * the classification (which app is focused, whether it is within the idle
 * timeout, whether the machine is suspended) always reflects state as it
 * was for the ENTIRE slice being closed out, not state as of the event
 * that closes it.
 */
function settleTo (state: AccountingState, t: number, idleTimeoutMs: number): AccountingState {
  const from = state.lastAccountedAt
  if (from === undefined) {
    return { ...state, lastAccountedAt: t } // first event ever: nothing precedes it
  }
  if (t <= from) {
    // Out-of-order or duplicate timestamp. Never accrue negative time, and
    // never move the anchor backward -- one misordered event must not
    // corrupt every accrual that follows it.
    return state
  }
  if (state.suspended) {
    return { ...state, lastAccountedAt: t } // asleep: this slice earns nothing, for anyone
  }

  let perApp = state.perApp
  const idleDeadline = state.lastInteractionAt === undefined ? -Infinity : state.lastInteractionAt + idleTimeoutMs

  for (const { start, end, period } of monthSlices(from, t)) {
    for (const app of Object.keys(state.openSessions)) {
      if (app === state.focusedApp) {
        // Focused: active until the idle deadline (if it falls inside this
        // slice), background for whatever remains after it.
        const activeUntil = Math.min(end, idleDeadline)
        if (activeUntil > start) {
          perApp = credit(perApp, app, period, 'activeSec', (activeUntil - start) / 1000)
        }
        const backgroundFrom = Math.max(start, idleDeadline)
        if (backgroundFrom < end) {
          perApp = credit(perApp, app, period, 'backgroundSec', (end - backgroundFrom) / 1000)
        }
      } else {
        // Open but not the focused app: running in the background for the
        // whole slice, regardless of the idle clock -- a background tab
        // cannot be "interacted with" while hidden.
        perApp = credit(perApp, app, period, 'backgroundSec', (end - start) / 1000)
      }
    }
  }

  return { ...state, perApp, lastAccountedAt: t }
}

/**
 * Applies one event to `state`, returning the next state.
 *
 * `idleTimeoutMs` defaults to DEFAULT_IDLE_TIMEOUT_MS; tests pass a small
 * value so scenarios do not need unrealistic event spacing to observe an
 * idle transition.
 */
export function applyEvent (state: AccountingState, event: TelemetryEvent, idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS): AccountingState {
  const settled = settleTo(state, event.atMs, idleTimeoutMs)

  switch (event.kind) {
    case 'session-start':
      return { ...settled, openSessions: withOpenSession(settled.openSessions, event.app) }

    case 'session-stop': {
      const openSessions = withoutOpenSession(settled.openSessions, event.app)
      const stillOpen = (openSessions[event.app] ?? 0) > 0
      const next = (!stillOpen && settled.focusedApp === event.app) ? refocus(settled, undefined) : settled
      return { ...next, openSessions }
    }

    case 'focus':
      return refocus(settled, event.app)

    case 'blur':
      return refocus(settled, undefined)

    case 'interaction':
      return { ...settled, lastInteractionAt: event.atMs }

    case 'suspend':
      return { ...settled, suspended: true }

    case 'resume':
      return { ...settled, suspended: false }

    case 'checkpoint':
      // No state effect beyond the settle already performed above. Exists
      // only so the caller has a periodic, otherwise-silent moment at
      // which to persist AccountingState -- see the module comment.
      return settled

    default: {
      // Exhaustiveness guard: a compile error at `exhaustive` is how a new
      // TelemetryEvent kind added without a case here gets caught, not a
      // runtime path reachable through the closed union above.
      const exhaustive: never = event
      throw new Error(`telemetry: unhandled event kind ${JSON.stringify(exhaustive)}`)
    }
  }
}

/** Equivalent to calling applyEvent once per event as a real collector would; this is the shape tests use. */
export function fold (events: readonly TelemetryEvent[], seed: AccountingState = initialState, idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS): AccountingState {
  return events.reduce((state, event) => applyEvent(state, event, idleTimeoutMs), seed)
}

/** Safe accessor: `{ activeSec: 0, backgroundSec: 0 }` for an app/period
 *  with no accrual yet, rather than undefined -- noUncheckedIndexedAccess
 *  would otherwise push that check onto every call site. */
export function totalsFor (state: AccountingState, app: AppId, period: Period): PeriodTotals {
  return state.perApp[app]?.[period] ?? { activeSec: 0, backgroundSec: 0 }
}
