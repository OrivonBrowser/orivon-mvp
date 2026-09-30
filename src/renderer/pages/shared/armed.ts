// A shared signal for "a two-click confirm's armed window just ended" --
// clear-data.ts's "Click again to clear" fires it, from both the timeout and
// the second click; a page's own render gate (settings/main.ts) listens, so
// a redraw held back while a `.armed` button waited for its second click is
// not lost once that window closes. Kept here, not in clear-data.ts itself,
// so any future two-click control in the same page can reuse it without
// importing one control's module to reach another's signal.
const listeners = new Set<() => void>()

export function armEnded (): void {
  for (const listener of listeners) listener()
}

/** Returns the unsubscribe. */
export function onArmEnded (listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
