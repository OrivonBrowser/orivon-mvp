// A burst of change events (an import saves one login at a time) becomes one call at the end of the turn, so
// every tab of every window is told once, not once for each row.

/** `run` is called once after the turn in which `notify` was called, however many times it was. */
export function oncePerTurn (run: () => void): () => void {
  let scheduled = false
  return () => {
    if (scheduled) return
    scheduled = true
    setImmediate(() => { scheduled = false; run() })
  }
}
