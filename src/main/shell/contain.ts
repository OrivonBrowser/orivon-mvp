// One feature's throw must not take down what every feature shares: the state push that feeds the chrome,
// and the wiring of a new tab view. A registry runs each entry through here so the fault is logged with
// the entry's name and the others still run.

/** `run`'s answer, or `fallback` after logging a throw with the name of the entry that owns it. */
export function contain<T> (what: string, fallback: T, run: () => T): T {
  try {
    return run()
  } catch (error) {
    console.error(`[shell] ${what} failed:`, error)
    return fallback
  }
}
