// Where a tab sits in the strip. Pure: a list of ids and a move.

/** Two tabs shown side by side, which the strip keeps next to each other. */
export type JoinedPair = readonly [string, string]

/** Where `index` (a place among `rest`) goes so that no pair in `rest` is split: a place between a pair's tabs
 * goes to the far edge of the pair from where the mover was (`from`, or -1 for a tab arriving from elsewhere). */
export function clearOfPairs (rest: readonly string[], index: number, pairs: readonly JoinedPair[], from: number): number {
  for (const [a, b] of pairs) {
    const at = rest.indexOf(a)
    if (at !== -1 && rest[at + 1] === b && index === at + 1) return from <= at ? at + 2 : at
  }
  return index
}

/** Moves `id` to `index` (clamped to the strip) in `order`, in place, past a joined pair rather than into it.
 * False when nothing changed. */
export function moveInOrder (order: string[], id: string, index: number, pairs: readonly JoinedPair[] = []): boolean {
  const from = order.indexOf(id)
  if (from === -1 || !Number.isFinite(index)) return false
  const wanted = Math.min(Math.max(0, Math.trunc(index)), order.length - 1)
  const to = clearOfPairs(order.filter((other) => other !== id), wanted, pairs, from)
  if (to === from) return false
  order.splice(from, 1)
  order.splice(to, 0, id)
  return true
}
