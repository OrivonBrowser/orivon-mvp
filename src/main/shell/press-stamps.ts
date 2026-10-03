// A toolbar button that opens a popup closes it again on its next click. The press on that button takes the focus the
// popup holds and closes it; the click arrives on release, and by then the popup is already gone. Telling that click
// from a fresh request needs the time of the press, in the clock the close was stamped with: main's own, never the page's.

/** The toolbar buttons whose presses main hears about: the main menu, the all-sites list, the site-info shield and key,
 * and the buttons that toggle an overlay, each named by the overlay it toggles. */
export const PRESS_BUTTONS = ['menu', 'permissions', 'web3', 'main', 'downloads', 'extensions-menu', 'popups-blocked', 'site-prompt', 'tab-search'] as const
export type PressButton = typeof PRESS_BUTTONS[number]

export function isPressButton (value: unknown): value is PressButton {
  return typeof value === 'string' && (PRESS_BUTTONS as readonly string[]).includes(value)
}

/** A toggle this soon after our own blur-close, with no press to judge by (a key), is taken to be its echo. */
export const REOPEN_DEBOUNCE_MS = 300

/** How far after the close a press may be stamped and still be the one that caused it: the message crosses a process boundary. */
export const PRESS_SKEW_MS = 50

/** A press older than this is not a click in progress; its stamp is dropped unread. */
export const PRESS_MAX_AGE_MS = 5_000

/**
 * Whether a toggle is the echo of the close the press caused. With a stamped press the answer does not depend on how
 * long the button was held: a close at or after the press (less the skew) is that press's own, an earlier one is
 * somebody else's. Without one the 300 ms rule applies. Every argument is a time from main's one clock.
 */
export function isEchoOfClose (closedAt: number, pressedAt: number | undefined, now: number): boolean {
  if (pressedAt !== undefined) return closedAt >= pressedAt - PRESS_SKEW_MS
  return now - closedAt < REOPEN_DEBOUNCE_MS
}

export interface PressStamps {
  /** The chrome page says a pointer went down on `button`: stamps it with main's clock on receipt. */
  note: (button: PressButton) => void
  /** The stamp of `button`'s press, once: the click that follows consumes it. Undefined for a key, or when the stamp is older than PRESS_MAX_AGE_MS. */
  take: (button: PressButton) => number | undefined
}

export function createPressStamps (clock: () => number = Date.now): PressStamps {
  const stamps = new Map<PressButton, number>()
  return {
    note (button) { stamps.set(button, clock()) },
    take (button) {
      const at = stamps.get(button)
      stamps.delete(button)
      return at !== undefined && clock() - at <= PRESS_MAX_AGE_MS ? at : undefined
    }
  }
}
