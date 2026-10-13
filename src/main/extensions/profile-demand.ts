// Whether a profile session has a reason to run the person's extensions: a website is open in it, or a view is about to be
// made in it. The direct profile's extensions run only while this is true, so nothing of theirs makes a request in that
// session while no website the person left out of the tunnel is open. Pure over a clock and a timer.

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
  /** A page of a website is open in the session; `key` names it (its web contents id). */
  readonly opened: (key: number) => void
  readonly closed: (key: number) => void
  readonly isOpen: () => boolean
  /** Called with the new answer whenever it changes. */
  readonly onChange: (listener: (open: boolean) => void) => void
}

export function createProfileDemand (clock: DemandClock): ProfileDemand {
  const pages = new Set<number>()
  let wakeUntil = 0
  let timer: unknown
  let reported = false
  const listeners: Array<(open: boolean) => void> = []

  const answer = (): boolean => pages.size > 0 || clock.now() < wakeUntil

  const evaluate = (): void => {
    if (timer !== undefined) {
      clock.clearTimer(timer)
      timer = undefined
    }
    const open = answer()
    if (open && pages.size === 0) {
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
    opened: (key) => {
      // The view the wake announced has come: the page now holds the answer by itself.
      wakeUntil = 0
      pages.add(key)
      evaluate()
    },
    closed: (key) => {
      if (pages.delete(key)) evaluate()
    },
    isOpen: answer,
    onChange: (listener) => { listeners.push(listener) }
  }
}
