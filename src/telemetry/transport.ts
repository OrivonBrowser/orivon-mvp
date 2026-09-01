// Decides WHETHER and WHAT to send, with every effect that touches the
// outside world -- the network call, the current time -- passed in by the
// caller rather than reached for directly. That is what makes this module
// pure and testable with no real network and no real clock: a test drives
// it with a fake Sender and a fake Clock and asserts on the exact next
// state, the same way accounting.ts is tested by feeding a fixed event
// array (see src/telemetry/README.md).
//
// THE RULE EVERYTHING HERE SERVES: mayTransmit (disclosure.ts) is
// consulted on every call to attemptSend, not once at startup and cached.
// A user who opts out mid-session must stop being measured on the very
// next attempt -- caching the answer at startup is exactly the shortcut
// that would violate that, silently, because nothing else here would
// notice the change.
//
// WHAT "BATCHING" MEANS HERE: ADR-0004 already settled the wire shape at
// one aggregate object per period (installId/country/version/period/
// perApp) -- there is no per-event payload to batch in the first place.
// "Do not send per event" is enforced by this module's own input type:
// attemptSend only ever sees a TelemetryPayload (built once, from
// disclosure.ts's buildDisclosurePayload), never a raw TelemetryEvent, so
// no code path here could fire one request per accounting event even by
// accident. What this module adds on top is a small outbox: enqueue
// stages a period's payload, attemptSend sends at most one queued payload
// per call, gated by consent and by backoff.
//
// WHY A QUEUE AT ALL, GIVEN ADR-0004 warns against "queue-and-retry into a
// backlog that reconstructs the timeline just removed": that warning is
// about resurrecting PER-SESSION granularity -- the design this ADR
// replaced. A short queue of already-aggregated monthly payloads is not
// that: it is bounded (MAX_QUEUE_SIZE) and every entry is already the
// coarse, already-approved shape. The cap exists so a device offline for
// months does not grow that backlog without limit; see enqueue for
// exactly how it is bounded. The size is a judgment call, not sourced
// from any document -- flagged rather than silently picked.

import { mayTransmit, type ConsentState, type TelemetryPayload } from './disclosure.js'
import { keepNewest, type HistoryEntry } from './history.js'

/** Reads the current time. Injected so this module never calls Date.now()
 *  itself -- a test supplies a fake it can advance deterministically,
 *  which is what makes the backoff tests exact rather than timing-flaky. */
export type Clock = () => number

/**
 * Sends one payload and reports success or failure -- nothing else.
 * ADR-0004 requires the client to "ignore the response body entirely", so
 * this type has no room to return one: a real implementation makes the
 * HTTP call and reduces whatever happened to this boolean.
 *
 * SHOULD resolve `false` rather than throw for an ordinary network
 * failure, but attemptSend does not depend on that discipline: it treats
 * a throw exactly like `false` (see its try/catch), so a Sender that
 * throws anyway still cannot block or crash the app.
 */
export type Sender = (payload: TelemetryPayload) => Promise<boolean>

/** One period's payload, waiting to be sent. */
export interface QueuedPayload {
  readonly payload: TelemetryPayload
  readonly enqueuedAtMs: number
}

export interface TransportState {
  readonly queue: readonly QueuedPayload[]
  /** Consecutive failures on the item currently at the head of the queue.
   *  Reset to 0 once that item is sent successfully. */
  readonly failureCount: number
  /** Backoff gate: attemptSend refuses to call the sender again before
   *  this instant. `undefined` means no backoff is in effect. */
  readonly nextAttemptAtMs: number | undefined
  /** Set the instant attemptSend starts awaiting the sender for the
   *  current head, cleared the instant it resolves either way.
   *  `undefined` means nothing is currently being sent. See
   *  IN_FLIGHT_STALE_AFTER_MS for why a value this old is ignored rather
   *  than trusted forever. */
  readonly inFlightSince: number | undefined
}

export const initialTransportState: TransportState = {
  queue: [],
  failureCount: 0,
  nextAttemptAtMs: undefined,
  inFlightSince: undefined
}

/**
 * How many periods' worth of unsent payload the queue holds before the
 * oldest is dropped. No document sizes this figure (flagged -- AI
 * judgment call, the same status as accounting.ts's
 * DEFAULT_IDLE_TIMEOUT_MS): three is enough to ride out a multi-month
 * offline stretch without retrying forever, while staying far short of
 * anything that could be called a reconstructed timeline. A caller may
 * override it; see enqueue.
 */
export const MAX_QUEUE_SIZE = 3

export const BASE_BACKOFF_MS = 30_000 // 30s
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000 // 6h

/**
 * How long an inFlightSince marker is trusted before attemptSend treats it
 * as stale and proceeds anyway. No document sizes this figure either
 * (flagged -- AI judgment call): it exists purely so a process that
 * crashes mid-send, with the marker already persisted, does not wedge the
 * queue forever on restart. Five minutes is generously longer than any
 * real send should take, while still being short next to BASE_BACKOFF_MS
 * and MAX_BACKOFF_MS.
 */
export const IN_FLIGHT_STALE_AFTER_MS = 5 * 60 * 1000 // 5m

/**
 * Doubling backoff, capped, so a down endpoint is not hammered and a
 * temporary blip does not wait so long that it misses the rest of the
 * send window ADR-0004 describes ("a randomised offset" within the
 * period). `failureCount <= 0` (nothing has failed yet) returns 0.
 */
export function computeBackoffMs (failureCount: number): number {
  if (failureCount <= 0) return 0
  const delay = BASE_BACKOFF_MS * 2 ** (failureCount - 1)
  return Math.min(delay, MAX_BACKOFF_MS)
}

/**
 * Replaces the entry for `payload`'s period IN PLACE when one is already
 * queued, appending only when the period is new. Replacing in place (not
 * filter-then-append) is what keeps FIFO order stable across a refresh --
 * accounting keeps accruing through the month, so a later enqueue for a
 * period already queued carries more complete totals, and that update
 * must not shove the entry to the back of the queue just because it was
 * touched again.
 */
function upsert (queue: readonly QueuedPayload[], payload: TelemetryPayload, enqueuedAtMs: number): readonly QueuedPayload[] {
  const index = queue.findIndex((entry) => entry.payload.period === payload.period)
  if (index === -1) return [...queue, { payload, enqueuedAtMs }]
  const next = [...queue]
  next[index] = { payload, enqueuedAtMs }
  return next
}

/**
 * Stages `payload` to be sent. Refuses outright unless `consentState` is
 * 'accepted': payloads are monthly aggregates built from accounting.ts at
 * send time, not an append-only event log, so a user who accepts partway
 * through a period still gets the whole period's totals on the next call
 * -- there is nothing to lose by never staging anything before a choice is
 * made, and it is what keeps a decline (or an undecided visit) from ever
 * having a backlog to purge in the first place.
 *
 * Updates an already-queued period in place (see upsert) rather than
 * filter-and-append, then applies the cap: once the queue is over
 * `maxQueueSize`, the OLDEST entries are dropped first, keeping the most
 * recent periods, the ones a returning-online user would most want
 * reflected.
 *
 * If the resulting head is a different payload than the one currently at
 * the head of `state.queue` -- a fresh period landing in an empty queue,
 * or the cap evicting the old head outright -- failureCount and
 * nextAttemptAtMs are reset. TransportState's own doc comment says
 * failureCount means "failures on the item currently at the head of the
 * queue"; carrying a stale backoff over onto an unrelated payload would
 * gate its very first attempt behind a delay it never earned.
 */
export function enqueue (state: TransportState, payload: TelemetryPayload, consentState: ConsentState, clock: Clock, maxQueueSize: number = MAX_QUEUE_SIZE): TransportState {
  if (consentState !== 'accepted') return state

  const now = clock()
  const queue = keepNewest(upsert(state.queue, payload, now), maxQueueSize)
  const headChanged = state.queue[0]?.payload.period !== queue[0]?.payload.period

  return {
    queue,
    failureCount: headChanged ? 0 : state.failureCount,
    nextAttemptAtMs: headChanged ? undefined : state.nextAttemptAtMs,
    inFlightSince: headChanged ? undefined : state.inFlightSince
  }
}

/**
 * What attemptSend produced: the possibly-updated state, and -- only on
 * an actual successful send -- what went out and when. `sent` is
 * `undefined` for every other outcome (refused by consent, still backing
 * off, empty queue, or a failed attempt). A caller wiring this to
 * history.ts's recordSent only ever passes this field through, so "if a
 * send fails, it is not history" holds by construction, not by
 * discipline at the call site.
 */
export interface SendResult {
  readonly state: TransportState
  readonly sent: HistoryEntry | undefined
}

/**
 * Discards the backlog outright. This is the explicit seam a
 * settings-screen consent toggle can call the moment the user withdraws --
 * attemptSend also calls this internally on 'declined' (see below), so the
 * purge happens even if no UI ever calls this directly, but a named export
 * means the wiring does not have to rely on "the next attemptSend happens
 * to purge it". Not "clear the queue and leave the rest of state alone":
 * failureCount and nextAttemptAtMs were earned by a payload that no
 * longer exists, so this is a full reset, not just an empty queue.
 */
export function onConsentWithdrawn (state: TransportState): TransportState {
  return initialTransportState
}

/**
 * Sends at most one payload -- the head of the queue -- per call. Never
 * throws and never rejects: every path, including a Sender that throws,
 * resolves to a SendResult, which is what "never block the app" means at
 * the type level here. A failed or refused send is silently dropped or
 * left queued for a later call; nothing here is surfaced to the user as
 * an error.
 *
 * Order of checks matters: consent is checked FIRST, on every call,
 * before the queue or the backoff gate are even consulted -- so a decline
 * is honoured before this function does anything else, and there is no
 * path (e.g. "the backoff gate has already opened") that could send one
 * more payload after a decline lands. A decline does more than refuse --
 * it purges (onConsentWithdrawn), because a queue that merely goes quiet
 * while declined and drains the moment consent is re-enabled would send a
 * backlog of activity staged while telemetry was supposedly off. An
 * 'undecided' caller, by contrast, leaves state untouched: enqueue (below)
 * already refuses to stage anything before a choice is made, so there is
 * nothing to purge in that case.
 */
export async function attemptSend (state: TransportState, consentState: ConsentState, sender: Sender, clock: Clock): Promise<SendResult> {
  if (!mayTransmit(consentState)) {
    return consentState === 'declined'
      ? { state: onConsentWithdrawn(state), sent: undefined }
      : { state, sent: undefined }
  }

  const head = state.queue[0]
  if (head === undefined) return { state, sent: undefined }

  const now = clock()
  if (state.nextAttemptAtMs !== undefined && now < state.nextAttemptAtMs) {
    return { state, sent: undefined } // still backing off; do not call the sender yet
  }

  if (state.inFlightSince !== undefined && now - state.inFlightSince < IN_FLIGHT_STALE_AFTER_MS) {
    return { state, sent: undefined } // another attemptSend on this same state is already sending the head
  }

  // Marked IN PLACE on the object the caller passed in, before the only
  // await below -- a deliberate exception to this module's "always return
  // a new object, never mutate the input" style. Two attemptSend calls
  // given the very same state object (a timer tick and a
  // send-on-consent-change trigger overlapping, say) each run to their
  // first await before either one resumes, so only a synchronous write to
  // something they both hold a reference to can stop the second one from
  // also passing the guard above and calling the sender a second time.
  // Returning a new object at the very end -- this function's usual
  // pattern -- would be invisible to that second call until it was too
  // late.
  //
  // The `finally` below undoes this same mutation on this same object
  // once the send settles, on top of the ordinary returned-object cleanup
  // further down. Without it, a caller that (legitimately, sequentially --
  // no overlap at all) reuses this exact state object for a second, later
  // call would find the marker permanently stuck, because only the
  // returned object would ever have been cleared.
  markInFlight(state, now)

  let ok: boolean
  try {
    ok = await sender(head.payload)
  } catch {
    ok = false // a thrown error is a failed attempt, not a crash -- see Sender's doc comment
  } finally {
    markInFlight(state, undefined)
  }

  if (ok) {
    return {
      state: { queue: state.queue.slice(1), failureCount: 0, nextAttemptAtMs: undefined, inFlightSince: undefined },
      sent: { payload: head.payload, sentAtMs: now }
    }
  }

  const failureCount = state.failureCount + 1
  return {
    state: { ...state, failureCount, nextAttemptAtMs: now + computeBackoffMs(failureCount), inFlightSince: undefined },
    sent: undefined
  }
}

/** The one deliberate mutation in this module -- see attemptSend's comment
 *  at its call site for why it has to be one. TransportState's field is
 *  `readonly` for every other caller; this cast is the single, narrow
 *  exception. Called with `undefined` to revert the mutation once the
 *  send this marker was guarding has settled. */
function markInFlight (state: TransportState, value: number | undefined): void {
  (state as { inFlightSince: number | undefined }).inFlightSince = value
}
