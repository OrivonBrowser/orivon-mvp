// How many live pages an origin has, and one-shot notice when that count
// returns to zero. No `electron` import: fed events by ./watch-pages.ts,
// which derives them from real WebContents; tested here with synthetic ones.

export interface PageTracker {
  /** One more live page at `origin` (a page committed a new document there). */
  recordPageOpened (origin: string): void
  /** One fewer live page at `origin` (its document went away: navigated off, destroyed, or crashed). */
  recordPageClosed (origin: string): void
  /** Live page count at `origin`, 0 if none. */
  countAt (origin: string): number
  /**
   * Calls `listener` once, the next time `origin`'s count drops to zero --
   * never for an origin already at zero when this is called, since nothing
   * would fire it. Returns an unsubscribe, for a caller that closes the
   * origin's host itself before the count would have reached zero (a
   * subsystem shutdown closing every host at once).
   */
  onceEmpty (origin: string, listener: () => void): () => void
}

export function createPageTracker (): PageTracker {
  const counts = new Map<string, number>()
  const listeners = new Map<string, Set<() => void>>()

  function fireEmpty (origin: string): void {
    const set = listeners.get(origin)
    if (set === undefined) return
    listeners.delete(origin)
    for (const listener of set) listener()
  }

  function countAt (origin: string): number {
    return counts.get(origin) ?? 0
  }

  return {
    countAt,
    recordPageOpened (origin) {
      counts.set(origin, countAt(origin) + 1)
    },
    recordPageClosed (origin) {
      const next = countAt(origin) - 1
      if (next > 0) { counts.set(origin, next); return }
      counts.delete(origin)
      fireEmpty(origin)
    },
    onceEmpty (origin, listener) {
      if (countAt(origin) === 0) return () => {}
      const set = listeners.get(origin) ?? new Set<() => void>()
      set.add(listener)
      listeners.set(origin, set)
      return () => { listeners.get(origin)?.delete(listener) }
    }
  }
}
