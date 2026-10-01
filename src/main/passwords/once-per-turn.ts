// A burst of change events (an import saves one login at a time) becomes one call at the end of the turn, so
// every tab of every window is told once, not once for each row.

export interface OncePerTurn {
  (): void
  /** Drops a call that is waiting for the end of the turn. */
  cancel: () => void
}

/** `run` is called once after the turn in which the returned function was called, however many times it was. */
export function oncePerTurn (run: () => void): OncePerTurn {
  let scheduled: ReturnType<typeof setImmediate> | undefined
  const notify = (): void => {
    if (scheduled !== undefined) return
    scheduled = setImmediate(() => { scheduled = undefined; run() })
  }
  notify.cancel = (): void => {
    if (scheduled !== undefined) clearImmediate(scheduled)
    scheduled = undefined
  }
  return notify
}
