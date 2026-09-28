// Where a tab sits in the strip. Pure: a list of ids and a move.

/** Moves `id` to `index` (clamped to the strip) in `order`, in place. False when nothing changed. */
export function moveInOrder (order: string[], id: string, index: number): boolean {
  const from = order.indexOf(id)
  if (from === -1 || !Number.isFinite(index)) return false
  const to = Math.min(Math.max(0, Math.trunc(index)), order.length - 1)
  if (to === from) return false
  order.splice(from, 1)
  order.splice(to, 0, id)
  return true
}
