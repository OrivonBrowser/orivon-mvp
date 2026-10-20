// When Orivon asks to be the default browser: after the first app has opened, or on the second calendar day of use,
// whichever comes first, then a week after it last asked, until the person says to stop. The state is three facts in a
// small file of the default profile; everything here is a pure rule over them, the clock and the moment an app last
// finished loading in this run, so a test sets the days and never waits.

export const DAY_MS = 86_400_000
/** The first ask comes this long after an app finishes loading: the page is on screen before the question is. */
export const APP_OPEN_BEAT_MS = 3_000
/** The ask comes back this many days after the last one. */
export const ASK_EVERY_DAYS = 7

export interface AskState {
  readonly firstSeenAt: number
  /** Null until the first ask. */
  readonly lastAskedAt: number | null
  readonly stopped: boolean
}

/** A profile seen in use for the first time: not asked yet. */
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

/** The start of the calendar day after the one `at` falls in, by the clock on the wall. */
export function startOfNextDay (at: number): number {
  const day = new Date(at)
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime()
}

/**
 * When the next ask falls due, or undefined once the person has said to stop. The first ask falls due at the earlier of
 * the second calendar day of use and a beat after an app finished loading (`appOpenedAt`, which is undefined while none
 * has in this run); a profile that has been asked comes back a week after its last ask.
 */
export function askDueAt (state: AskState, appOpenedAt?: number): number | undefined {
  if (state.stopped) return undefined
  if (state.lastAskedAt !== null) return state.lastAskedAt + ASK_EVERY_DAYS * DAY_MS
  const secondDay = startOfNextDay(state.firstSeenAt)
  return appOpenedAt === undefined ? secondDay : Math.min(secondDay, appOpenedAt + APP_OPEN_BEAT_MS)
}

export const askDue = (state: AskState, now: number, appOpenedAt?: number): boolean => {
  const at = askDueAt(state, appOpenedAt)
  return at !== undefined && now >= at
}

/** The ask was shown and the person did not take it, or Orivon turned out to be the default already. */
export const askedNow = (state: AskState, now: number): AskState => ({ ...state, lastAskedAt: now })

export const stoppedAsking = (state: AskState): AskState => ({ ...state, stopped: true })
