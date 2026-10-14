// Whether a profile session has a reason to run the person's extensions: a website is open in it, or a view is about to be
// made in it. A profile's extensions run only while this is true, so nothing of theirs is loaded or makes a request in that
// session while no website is open in it. Pure over a clock and a timer.

/** How long a view about to be made counts as open when it never appears (a tab that failed to start). */
export const WAKE_GRACE_MS = 15_000

export interface DemandClock {
  readonly now: () => number
  readonly setTimer: (run: () => void, ms: number) => unknown
  readonly clearTimer: (timer: unknown) => void
}

export interface ProfileDemand {
  /** A view is about to be made in the session. */
  readonly wake: () => void
  /**
   * A page is open in the session; `key` names it (its web contents id). `isWebsite` is asked each time the answer is worked out:
   * a page of an extension that the person or an extension opened in the session is a page, not a website, and keeps nothing running.
   */
  readonly opened: (key: number, isWebsite?: () => boolean) => void
  readonly closed: (key: number) => void
  /** A page may have changed what it shows (a navigation): the answer is worked out again. */
  readonly recheck: () => void
  readonly isOpen: () => boolean
  /** Called with the new answer whenever it changes. */
  readonly onChange: (listener: (open: boolean) => void) => void
}

export function createProfileDemand (clock: DemandClock): ProfileDemand {
  const pages = new Map<number, () => boolean>()
  let wakeUntil = 0
  let timer: unknown
  let reported = false
  const listeners: Array<(open: boolean) => void> = []

  const websites = (): number => [...pages.values()].filter((isWebsite) => isWebsite()).length
  const answer = (): boolean => websites() > 0 || clock.now() < wakeUntil

  const evaluate = (): void => {
    if (timer !== undefined) {
      clock.clearTimer(timer)
      timer = undefined
    }
    const open = answer()
    if (open && websites() === 0) {
      timer = clock.setTimer(() => { timer = undefined; evaluate() }, Math.max(0, wakeUntil - clock.now()) + 1)
    }
    if (open === reported) return
    reported = open
    for (const listener of listeners) listener(open)
  }

  return {
    wake: () => {
      wakeUntil = clock.now() + WAKE_GRACE_MS
      evaluate()
    },
    opened: (key, isWebsite = () => true) => {
      // The view the wake announced has come: the page now holds the answer by itself.
      wakeUntil = 0
      pages.set(key, isWebsite)
      evaluate()
    },
    recheck: evaluate,
    closed: (key) => {
      if (pages.delete(key)) evaluate()
    },
    isOpen: answer,
    onChange: (listener) => { listeners.push(listener) }
  }
}
