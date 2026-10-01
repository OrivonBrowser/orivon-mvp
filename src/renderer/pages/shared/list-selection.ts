// Which rows of a list are selected, and where the focus goes next. Pure functions over the ids in the order they
// are on screen, shared by the pages that list things a person can select. An id is whatever the page keys its rows by.

export type Step = 'up' | 'down' | 'first' | 'last'

export function toggle<T> (selected: ReadonlySet<T>, id: T): Set<T> {
  const next = new Set(selected)
  if (!next.delete(id)) next.add(id)
  return next
}

/** Every row from `anchor` to `target`, both included; with no anchor, `target` alone. */
export function range<T> (ids: readonly T[], anchor: T | null, target: T): Set<T> {
  const from = anchor === null ? -1 : ids.indexOf(anchor)
  const to = ids.indexOf(target)
  if (to === -1) return new Set()
  if (from === -1) return new Set([target])
  return new Set(ids.slice(Math.min(from, to), Math.max(from, to) + 1))
}

export function all<T> (ids: readonly T[]): Set<T> {
  return new Set(ids)
}

/** What is still selected among the rows now shown. */
export function keepShown<T> (selected: ReadonlySet<T>, ids: readonly T[]): Set<T> {
  const shown = new Set(ids)
  return new Set([...selected].filter((id) => shown.has(id)))
}

/** The row a key moves the focus to; the first when none has it, and the ends hold. */
export function step<T> (ids: readonly T[], current: T | null, how: Step): T | null {
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
export function focusAfterRemoval<T> (ids: readonly T[], removed: ReadonlySet<T>, from: T | null): T | null {
  const remaining = ids.filter((id) => !removed.has(id))
  if (remaining.length === 0) return null
  const at = from === null ? -1 : ids.indexOf(from)
  if (at === -1) return remaining[0] ?? null
  const below = ids.slice(at).find((id) => !removed.has(id))
  if (below !== undefined) return below
  return [...ids.slice(0, at)].reverse().find((id) => !removed.has(id)) ?? null
}
