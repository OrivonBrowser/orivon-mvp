// When Orivon asks to be the default browser again: a week after it last asked, until the person says to stop. The
// state is three facts in a small file of the default profile; everything here is a pure rule over them and the
// clock, so a test sets the days and never waits.

export const DAY_MS = 86_400_000
/** The ask comes back this many days after the last one. */
export const ASK_EVERY_DAYS = 7
/** "Don't ask again" is offered once this many days have passed since the browser first saw the profile: a person gets two asks before it. */
export const STOP_AFTER_DAYS = 14

export interface AskState {
  readonly firstSeenAt: number
  readonly lastAskedAt: number
  readonly stopped: boolean
}

/** A profile seen for the first time counts as asked just now: a first install is asked on the welcome screen, and the first weekly ask is a week later. */
export const firstSight = (now: number): AskState => ({ firstSeenAt: now, lastAskedAt: now, stopped: false })

export interface ReadAsk {
  readonly state: AskState
  /** The file was missing, corrupt or ahead of the clock, and `state` is what should now be written. */
  readonly repaired: boolean
}

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** The state a file's text holds. A missing or corrupt file is made again; a time ahead of the clock (a wrong clock was set right) is reset to now, since a week counted from a future date would never end. */
export function readAskState (text: string | undefined, now: number): ReadAsk {
  let parsed: unknown
  try {
    parsed = text === undefined ? undefined : JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const record = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  const { firstSeenAt, lastAskedAt, stopped } = record ?? {}
  if (!isTime(firstSeenAt) || !isTime(lastAskedAt) || typeof stopped !== 'boolean') return { state: firstSight(now), repaired: true }
  const state: AskState = { firstSeenAt: Math.min(firstSeenAt, now), lastAskedAt: Math.min(lastAskedAt, now), stopped }
  return { state, repaired: state.firstSeenAt !== firstSeenAt || state.lastAskedAt !== lastAskedAt }
}

export const askDue = (state: AskState, now: number): boolean => !state.stopped && now - state.lastAskedAt >= ASK_EVERY_DAYS * DAY_MS

export const canStop = (state: AskState, now: number): boolean => now - state.firstSeenAt >= STOP_AFTER_DAYS * DAY_MS

/** The ask was shown and the person did not take it, or Orivon turned out to be the default already. */
export const askedNow = (state: AskState, now: number): AskState => ({ ...state, lastAskedAt: now })

export const stoppedAsking = (state: AskState): AskState => ({ ...state, stopped: true })
