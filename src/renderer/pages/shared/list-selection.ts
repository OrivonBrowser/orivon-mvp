// Which rows of a list are selected, and where the focus goes next. Pure functions over the ids in the order they
// are on screen, shared by the pages that list things a person can select.

export type Step = 'up' | 'down' | 'first' | 'last'

export function toggle (selected: ReadonlySet<number>, id: number): Set<number> {
  const next = new Set(selected)
  if (!next.delete(id)) next.add(id)
  return next
}

/** Every row from `anchor` to `target`, both included; with no anchor, `target` alone. */
export function range (ids: readonly number[], anchor: number | null, target: number): Set<number> {
  const from = anchor === null ? -1 : ids.indexOf(anchor)
  const to = ids.indexOf(target)
  if (to === -1) return new Set()
  if (from === -1) return new Set([target])
  return new Set(ids.slice(Math.min(from, to), Math.max(from, to) + 1))
}

export function all (ids: readonly number[]): Set<number> {
  return new Set(ids)
}

/** What is still selected among the rows now shown. */
export function keepShown (selected: ReadonlySet<number>, ids: readonly number[]): Set<number> {
  const shown = new Set(ids)
  return new Set([...selected].filter((id) => shown.has(id)))
}

/** The row a key moves the focus to; the first when none has it, and the ends hold. */
export function step (ids: readonly number[], current: number | null, how: Step): number | null {
  if (ids.length === 0) return null
  const at = current === null ? -1 : ids.indexOf(current)
  switch (how) {
    case 'first': return ids[0] ?? null
    case 'last': return ids.at(-1) ?? null
    case 'up': return ids[Math.max(0, at === -1 ? 0 : at - 1)] ?? null
    case 'down': return ids[Math.min(ids.length - 1, at + 1)] ?? null
  }
}

/** Where the focus goes once `removed` rows are gone: the next row below the one it was on, else the one above. */
export function focusAfterRemoval (ids: readonly number[], removed: ReadonlySet<number>, from: number | null): number | null {
  const remaining = ids.filter((id) => !removed.has(id))
  if (remaining.length === 0) return null
  const at = from === null ? -1 : ids.indexOf(from)
  if (at === -1) return remaining[0] ?? null
  const below = ids.slice(at).find((id) => !removed.has(id))
  if (below !== undefined) return below
  return [...ids.slice(0, at)].reverse().find((id) => !removed.has(id)) ?? null
}
