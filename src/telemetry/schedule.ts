// The timing policy: how often the runner checkpoints/persists, how often
// it checks whether a send is due, and how the "randomised offset" ADR-0004
// asks for ("send once per period at a randomised offset; do not
// queue-and-retry into a backlog", transport.ts's own header) is chosen.
// Pure and injectable, same reason accounting.ts takes idleTimeoutMs as a
// parameter and transport.ts takes a Clock: a test can pin the "random"
// source and assert an exact number, instead of asserting a range and
// hoping.
//
// Every constant below is an AI judgment call, not sized by any document --
// same status as accounting.ts's DEFAULT_IDLE_TIMEOUT_MS and transport.ts's
// IN_FLIGHT_STALE_AFTER_MS, flagged here for the same reason.

/** How often the checkpoint timer fires: settle accounting up to now, poll
 *  for interaction/window changes, and persist. Bounds how much activeSec
 *  an abnormal termination can lose to at most one interval's worth. */
export const CHECKPOINT_INTERVAL_MS = 60_000 // 1 minute

/** How often the send timer wakes up to check whether the scheduled offset
 *  (see pickSendOffsetMs) has elapsed and a send attempt is due. Coarser
 *  than the checkpoint interval -- a send is, at most, once per period. */
export const SEND_CHECK_INTERVAL_MS = 15 * 60_000 // 15 minutes

/** The width of the window a period's first send attempt is randomised
 *  into (ADR-0004: "a randomised offset"), so installs that launch around
 *  the same moment (e.g. the top of the hour, or a release-day surge)
 *  don't all reach the ingest endpoint at once. */
export const SEND_OFFSET_WINDOW_MS = 6 * 60 * 60 * 1000 // 6 hours

/** Passed to powerMonitor.getSystemIdleState() on each checkpoint tick.
 *  Equal to CHECKPOINT_INTERVAL_MS/1000 deliberately: "was there input
 *  since the last tick" is exactly the granularity a periodic poll can
 *  answer, and a shorter threshold would just report the same answer more
 *  often. */
export const IDLE_INTERACTION_THRESHOLD_SEC = CHECKPOINT_INTERVAL_MS / 1000

/**
 * Scales an injected [0, 1) random source into [0, windowMs) whole
 * milliseconds. `random` defaults to Math.random; a test pins it to get an
 * exact, non-flaky number instead of asserting a range.
 */
export function pickSendOffsetMs (random: () => number = Math.random, windowMs: number = SEND_OFFSET_WINDOW_MS): number {
  return Math.floor(random() * windowMs)
}

/**
 * True when a previously-computed offset no longer applies -- either none
 * has been computed yet (`undefined`), or the calendar period has rolled
 * over since it was. A stale offset must be recomputed for the new period
 * rather than reused, or a send scheduled late in August would still gate
 * September's very first attempt.
 */
export function isOffsetStale (offsetPeriod: string | undefined, currentPeriod: string): boolean {
  return offsetPeriod !== currentPeriod
}
