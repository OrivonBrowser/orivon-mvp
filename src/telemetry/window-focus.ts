// Decides "is the Orivon shell, as a whole, OS-focused" from the raw
// per-window focus state Electron reports -- pure, no Electron import, so
// it is testable without a real window. runner.ts is what actually reads
// real windows (via BaseWindow.getAllWindows()) and feeds them through
// this on every checkpoint tick.
//
// WHY THIS EXISTS SEPARATELY FROM accounting.ts's own 'focus'/'blur'
// events: accounting.ts's fold only cares about a TRANSITION (something
// became focused / nothing is focused any more), not the raw per-window
// state -- and the shell can, briefly, hold more than one BaseWindow at
// once (src/main/window.ts's A16 note: closing the last tab closes the
// window, and macOS's dock 'activate' can open a new one afterward).
// Losing focus on window A while window B already has it must read as
// "still focused", not a spurious blur-then-refocus pair that would reset
// accounting.ts's idle-interaction clock for no real reason.
export interface TrackedWindow {
  readonly id: number
  readonly focused: boolean
}

export type FocusTransition = 'gained-focus' | 'lost-focus' | 'unchanged'

export interface FocusReconciliation {
  /** The new set of window ids currently holding OS focus -- always a
   *  subset of `windows`' ids, since a closed window cannot stay "focused". */
  readonly nextFocusedIds: ReadonlySet<number>
  readonly transition: FocusTransition
}

/**
 * `prevFocusedIds` is whatever `nextFocusedIds` this function returned
 * last time (runner.ts holds it between ticks). `windows` is every
 * BaseWindow Electron currently reports, with its current focus state.
 */
export function reconcileWindowFocus (
  prevFocusedIds: ReadonlySet<number>,
  windows: readonly TrackedWindow[]
): FocusReconciliation {
  const nextFocusedIds = new Set(windows.filter((w) => w.focused).map((w) => w.id))
  const wasFocused = prevFocusedIds.size > 0
  const isFocused = nextFocusedIds.size > 0

  const transition: FocusTransition =
    !wasFocused && isFocused ? 'gained-focus'
      : wasFocused && !isFocused ? 'lost-focus'
        : 'unchanged'

  return { nextFocusedIds, transition }
}
