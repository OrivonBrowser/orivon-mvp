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

/** How many tabs of `order` are pinned: the length of the pinned run, which leads the strip. */
export function pinnedCount (order: readonly string[], isPinned: (id: string) => boolean): number {
  return order.filter(isPinned).length
}

/** The place among tabs whose centres are `centres` that a tab let go at `x` takes: after every tab whose centre is left of it. */
export function dropIndex (centres: readonly number[], x: number): number {
  return centres.filter((centre) => x > centre).length
}

/** Keeps a place inside the run its tab belongs to. `count` is the pinned run's length and `length` the strip's,
 * both without the mover: a pinned tab takes a place from 0 to `count`, any other from `count` to `length`. */
export function clampToRun (index: number, pinned: boolean, count: number, length: number): number {
  const [low, high] = pinned ? [0, count] : [count, length]
  return Math.min(Math.max(index, low), high)
}

/** Moves `id` to `index` (clamped to the strip and to the run of its kind) in `order`, in place, past a joined pair
 * rather than into it. False when nothing changed. */
export function moveInOrder (order: string[], id: string, index: number, pairs: readonly JoinedPair[] = [], isPinned: (id: string) => boolean = () => false): boolean {
  const from = order.indexOf(id)
  if (from === -1 || !Number.isFinite(index)) return false
  const rest = order.filter((other) => other !== id)
  const wanted = clampToRun(Math.min(Math.max(0, Math.trunc(index)), rest.length), isPinned(id), pinnedCount(rest, isPinned), rest.length)
  const to = clearOfPairs(rest, wanted, pairs, from)
  if (to === from) return false
  order.splice(from, 1)
  order.splice(to, 0, id)
  return true
}
