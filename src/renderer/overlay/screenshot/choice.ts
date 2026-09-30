// The sheet's two-way choice as pure state, so its keyboard rules are tested without a document.

export type Area = 'visible' | 'full'

export const AREAS: readonly Area[] = ['visible', 'full']

/** The area an arrow key moves to from `current`: the other one when it may be chosen, else where it is. */
export function areaAfterKey (current: Area, key: string, fullAvailable: boolean): Area {
  const step = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0
  if (step === 0) return current
  const next = AREAS[(AREAS.indexOf(current) + step + AREAS.length) % AREAS.length] ?? current
  return next === 'full' && !fullAvailable ? current : next
}

/** What the sheet is told on a show, read defensively: it comes over a channel that carries anything. */
export function fullPageOffered (payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && (payload as Record<string, unknown>)['fullPage'] === true
}
