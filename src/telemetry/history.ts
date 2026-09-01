// The append-only, capped record of what has actually been transmitted --
// the data behind the in-product "what has been sent" page ADR-0004 makes
// non-optional ("Inspectable, meaning the browser contains a page listing
// everything sent so far"). See src/telemetry/README.md.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE: an entry is written here only
// for a payload that was ACTUALLY sent, never one that was merely built or
// queued. transport.ts's attemptSend only ever hands back a `sent` value
// on a genuine successful send (see its SendResult doc comment); this
// module's contribution is to make that the ONLY thing it is capable of
// recording. recordSent takes one HistoryEntry, not a TelemetryPayload
// plus a "did it work" flag -- there is no call shape here that could
// record an attempt that failed.
//
// Pure, like every other module in this directory: no I/O, no clock of
// its own (the caller supplies sentAtMs, taken from wherever attemptSend
// read it), no electron or node:* import.

import type { TelemetryPayload } from './disclosure.js'

/** What was sent, and when. `sentAtMs` is the sender's own success
 *  instant -- attemptSend's clock() reading at the moment it resolved
 *  true -- not a value this module invents. */
export interface HistoryEntry {
  readonly payload: TelemetryPayload
  readonly sentAtMs: number
}

export interface HistoryState {
  readonly entries: readonly HistoryEntry[]
}

export const initialHistoryState: HistoryState = { entries: [] }

/**
 * How many past sends the record retains before the oldest is dropped.
 * No document sizes this figure (flagged -- AI judgment call, the same
 * status as accounting.ts's DEFAULT_IDLE_TIMEOUT_MS): at most one entry
 * is produced per period, so 36 covers three years of monthly sends --
 * comfortably past this MVP's measurement window -- without a long-lived
 * install growing the record forever. A caller may override it; see
 * recordSent.
 */
export const MAX_HISTORY_ENTRIES = 36

/**
 * Keeps at most the newest `max` items, dropping the oldest first.
 *
 * Shared by this module's own cap (recordSent, below) and transport.ts's
 * queue cap (enqueue) -- both are "cap a list to the newest N" for the
 * same reason (bound retained data against an unbounded offline stretch
 * or a long-lived install), so this is code-guidelines.md Rule 3's
 * "extract when the reason is shared" case, not two snippets that merely
 * look alike. It lives here rather than in a third file only because this
 * task's file list does not include one; see the PR for that tradeoff
 * made explicit.
 */
export function keepNewest<T> (items: readonly T[], max: number): readonly T[] {
  return items.length <= max ? items : items.slice(items.length - max)
}

/**
 * Appends `entry`. The only mutation this module performs on the record
 * is adding to the end -- append-only -- and, once the cap is passed,
 * dropping from the front: the OLDEST entries go first, so the page
 * always shows what just happened rather than losing it to make room for
 * history the user has already seen.
 */
export function recordSent (state: HistoryState, entry: HistoryEntry, maxEntries: number = MAX_HISTORY_ENTRIES): HistoryState {
  return { entries: keepNewest([...state.entries, entry], maxEntries) }
}
