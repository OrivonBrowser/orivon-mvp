// The first-run telemetry disclosure: the decidable, testable part of the
// screen ADR-0004 makes non-optional -- what is shown, what a choice
// means, when the screen may be shown, and the guarantee that nothing is
// transmitted before the user chooses. See src/telemetry/README.md and
// docs/decisions/ADR-0004-telemetry.md; verified operationally (traffic
// watched, not source read) by docs/development/release-checklist.md
// item 1.
//
// NOT HERE: the rendering. This module makes no electron import, no
// node:* import, performs no I/O and reads no clock -- every value a
// caller needs (accounting state, installId, country, version, period,
// and the persisted consent state itself) is passed in, and every value
// produced here is returned, never written anywhere. Persistence and the
// network transport are separate work; this module is what they are
// required to consult first (mayTransmit) and to render literally
// (buildDisclosurePayload), not paraphrase.
//
// A screen that technically appears but nudges toward "yes" passes a
// casual review while failing the actual intent. Equal weight and no
// preselection are therefore VALUES a test compares below, not notes
// left for whoever builds the view.

import type { AccountingState, AppId, Period, PeriodTotals } from './accounting.js'

// The literal payload

/**
 * The exact shape ADR-0004 commits to sending -- see its "entire payload"
 * block. Kept as its own type rather than reusing a slice of
 * AccountingState: the wire payload adds fields accounting.ts has no
 * reason to know about (installId, country, version) and narrows to one
 * rounded period.
 */
export interface TelemetryPayload {
  readonly installId: string
  readonly country: string
  readonly version: string
  readonly period: Period
  readonly perApp: Readonly<Record<AppId, PeriodTotals>>
}

/**
 * Everything buildDisclosurePayload needs beyond the accounting state
 * itself -- values this module has no way to produce on its own (no
 * clock, no locale lookup, no RNG for installId). The caller collects
 * these; this module only shapes them.
 */
export interface DisclosureMeta {
  readonly installId: string
  readonly country: string
  readonly version: string
  readonly period: Period
}

/**
 * Whole seconds. accounting.ts deliberately keeps exact fractional
 * seconds through its fold and defers rounding to "whatever later builds
 * [the wire] payload" (see its module comment) -- this is that place.
 * ADR-0004's own example payload shows integers ("activeSec": 90000), so
 * nearest-second rounding runs at this boundary; half a second either way
 * is immaterial against figures in the tens of thousands.
 */
function roundedTotals (totals: PeriodTotals): PeriodTotals {
  return {
    activeSec: Math.round(totals.activeSec),
    backgroundSec: Math.round(totals.backgroundSec)
  }
}

/**
 * Every app with a recorded entry for `period`, rounded. Reads
 * AccountingState's own `perApp` field directly rather than calling
 * accounting.ts's `totalsFor` once per known app id: `totalsFor` defaults
 * a missing entry to `{ activeSec: 0, backgroundSec: 0 }`, correct for a
 * caller asking about one specific app, but wrong here -- it would seed
 * the payload with a zero-filled app that simply never ran in `period`.
 * Only apps that actually have an entry for `period` appear.
 */
function perAppForPeriod (state: AccountingState, period: Period): Readonly<Record<AppId, PeriodTotals>> {
  const out: Record<AppId, PeriodTotals> = {}
  for (const app of Object.keys(state.perApp)) {
    const totals = state.perApp[app]?.[period]
    if (totals !== undefined) out[app] = roundedTotals(totals)
  }
  return out
}

/**
 * Produces exactly the object the transport sends -- not a description of
 * it, not a summary. This is the function the disclosure screen renders
 * as literal JSON.
 */
export function buildDisclosurePayload (state: AccountingState, meta: DisclosureMeta): TelemetryPayload {
  return {
    installId: meta.installId,
    country: meta.country,
    version: meta.version,
    period: meta.period,
    perApp: perAppForPeriod(state, meta.period)
  }
}

// The consent state: undecided is a real third value

/** What a completed choice settles into. Deliberately excludes
 *  'undecided' at the type level, so nothing typed to return this can
 *  ever hand back the pre-choice state. */
export type DecidedConsentState = 'accepted' | 'declined'

/**
 * The full state space: the pre-choice state plus either completed
 * choice. Three distinct values, not a boolean -- a boolean has no room
 * for "no choice yet" without overloading one of its two values to also
 * mean "declined", which is the preselection bug this type rules out
 * structurally rather than by convention.
 */
export type ConsentState = 'undecided' | DecidedConsentState

/** What a fresh profile starts in. Exported so every call site shares one definition of "fresh". */
export const initialConsentState: ConsentState = 'undecided'

/**
 * The first-run screen is gated on this one predicate rather than on a
 * separately tracked "has this run before" flag, so there is exactly one
 * source of truth for whether it may appear -- and once a choice lands in
 * either decided state, this is false for good, which is what keeps a
 * revisited choice from resurrecting the first-run screen (task requirement
 * 5).
 */
export function shouldPresentDisclosure (state: ConsentState): boolean {
  return state === 'undecided'
}

// The two options: equal weight, no preference

export type DisclosureChoiceId = 'keep-on' | 'turn-off'

/**
 * id, label and resultingState are the whole shape -- deliberately.
 * There is no field here a UI could read to decide "which button is the
 * recommended one", because none exists to set. Adding one (`primary`,
 * `recommended`, `isDefault`, or any field present on one option and not
 * the other) is exactly the mutation the equal-weight tests exist to
 * catch.
 */
export interface DisclosureOption {
  readonly id: DisclosureChoiceId
  readonly label: string
  readonly resultingState: DecidedConsentState
}

/**
 * ADR-0004's own button copy, in its own order: "[Keep on] / [Turn
 * off]". A fixed-length tuple, not a plain array, so "exactly two" is a
 * type-level fact and not only a runtime count.
 */
export const DISCLOSURE_OPTIONS: readonly [DisclosureOption, DisclosureOption] = [
  { id: 'keep-on', label: 'Keep on', resultingState: 'accepted' },
  { id: 'turn-off', label: 'Turn off', resultingState: 'declined' }
]

/**
 * Applies one of DISCLOSURE_OPTIONS -- first-run or revisited alike, the
 * same function serves both. That symmetry is what makes the choice
 * durable and revisitable (task requirement 5) rather than a one-shot
 * decision: a settings control calling this again later moves directly
 * between 'accepted' and 'declined'. Pure -- the caller persists the result.
 */
export function applyDisclosureChoice (option: DisclosureOption): DecidedConsentState {
  return option.resultingState
}

// The transmit guard

/**
 * The one function the transport (a separate task) is required to consult
 * before sending anything. Silence is not consent.
 */
export function mayTransmit (state: ConsentState): boolean {
  return state === 'accepted'
}
