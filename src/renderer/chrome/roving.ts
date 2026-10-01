// Which item an arrow, Home or End key moves to in a row of controls that share one Tab stop. Pure: the DOM side
// is ./roving-dom.ts.

export type RovingKey = 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End'

export const isRovingKey = (key: string): key is RovingKey => key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Home' || key === 'End'

/**
 * The index to move to from `current` (-1 when none holds focus), skipping every item whose flag in `enabled` is
 * false. The row does not wrap, so an arrow at an end stays where it is, and so does a row with nothing enabled.
 */
export function rovingTarget (enabled: readonly boolean[], current: number, key: RovingKey, wrap = false): number {
  const count = enabled.length
  const ok = (at: number): boolean => enabled[at] === true
  if (key === 'Home') {
    const first = enabled.indexOf(true)
    return first >= 0 ? first : current
  }
  if (key === 'End') {
    for (let at = count - 1; at >= 0; at--) if (ok(at)) return at
    return current
  }
  const step = key === 'ArrowRight' ? 1 : -1
  // From nowhere, an arrow goes in at the end it points away from.
  let at = current < 0 ? (step === 1 ? -1 : count) : current
  for (let tried = 0; tried < count; tried++) {
    at += step
    if (at < 0 || at >= count) {
      if (!wrap) return current
      at = (at + count) % count
    }
    if (ok(at)) return at
  }
  return current
}
