// When Orivon asks to be the default browser: half a minute after the person first uses it, then a week after it last
// asked, until the person says to stop. The state is three facts in a small file of the default profile; everything
// here is a pure rule over them and the clock, so a test sets the days and never waits.

export const DAY_MS = 86_400_000
/** The first ask comes this long after the profile is first seen in use: long enough to have seen the browser work. */
export const FIRST_ASK_AFTER_MS = 30_000
/** The ask comes back this many days after the last one. */
export const ASK_EVERY_DAYS = 7
/** "Don't ask again" is offered once this many days have passed since the browser first saw the profile: a person gets a few asks before it. */
export const STOP_AFTER_DAYS = 14

export interface AskState {
  readonly firstSeenAt: number
  /** Null until the first ask. */
  readonly lastAskedAt: number | null
  readonly stopped: boolean
}

/** A profile seen in use for the first time: not asked yet, and asked `FIRST_ASK_AFTER_MS` later. */
export const firstSight = (now: number): AskState => ({ firstSeenAt: now, lastAskedAt: null, stopped: false })

export interface ReadAsk {
  /** Undefined when the file is missing or corrupt: the profile has not been seen in use yet. */
  readonly state: AskState | undefined
  /** A time in the file was ahead of the clock and `state` has it at now: what should be written. */
  readonly repaired: boolean
}

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** The state a file's text holds. A time ahead of the clock (a wrong clock was set right) is reset to now, since a week counted from a future date would never end. */
export function readAskState (text: string | undefined, now: number): ReadAsk {
  let parsed: unknown
  try {
    parsed = text === undefined ? undefined : JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const record = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  const { firstSeenAt, lastAskedAt, stopped } = record ?? {}
  if (!isTime(firstSeenAt) || (lastAskedAt !== null && !isTime(lastAskedAt)) || typeof stopped !== 'boolean') return { state: undefined, repaired: false }
  const state: AskState = { firstSeenAt: Math.min(firstSeenAt, now), lastAskedAt: lastAskedAt === null ? null : Math.min(lastAskedAt, now), stopped }
  return { state, repaired: state.firstSeenAt !== firstSeenAt || state.lastAskedAt !== lastAskedAt }
}

/** When the next ask falls due, or undefined once the person has said to stop. */
export function askDueAt (state: AskState): number | undefined {
  if (state.stopped) return undefined
  return state.lastAskedAt === null ? state.firstSeenAt + FIRST_ASK_AFTER_MS : state.lastAskedAt + ASK_EVERY_DAYS * DAY_MS
}

export const askDue = (state: AskState, now: number): boolean => {
  const at = askDueAt(state)
  return at !== undefined && now >= at
}

export const canStop = (state: AskState, now: number): boolean => now - state.firstSeenAt >= STOP_AFTER_DAYS * DAY_MS

/** The ask was shown and the person did not take it, or Orivon turned out to be the default already. */
export const askedNow = (state: AskState, now: number): AskState => ({ ...state, lastAskedAt: now })

export const stoppedAsking = (state: AskState): AskState => ({ ...state, stopped: true })
