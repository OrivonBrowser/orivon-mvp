// The arithmetic of the panel's resize edge: a drag and the arrow keys, for a panel on either side. The limits
// come from main with every width it reports, so the page never holds a number of its own.

export type Side = 'left' | 'right'
export interface Limits { min: number, max: number, reset: number }

/** What one arrow key moves the edge. */
export const KEY_STEP = 16

const clamp = (width: number, limits: Limits): number => Math.min(limits.max, Math.max(limits.min, Math.round(width)))

/**
 * The width a drag gives: a panel on the right grows as the pointer moves left, one on the left as it moves right.
 * Both positions are screen coordinates, so the answer does not change as the panel's own view moves under the pointer.
 */
export function widthFromDrag (startWidth: number, startX: number, x: number, side: Side, limits: Limits): number {
  return clamp(side === 'right' ? startWidth + (startX - x) : startWidth + (x - startX), limits)
}

/** The width a key on the edge asks for, or null for a key that does nothing. The arrow toward the page widens. */
export function widthFromKey (key: string, width: number, side: Side, limits: Limits): number | null {
  switch (key) {
    case 'ArrowLeft': return clamp(side === 'right' ? width + KEY_STEP : width - KEY_STEP, limits)
    case 'ArrowRight': return clamp(side === 'right' ? width - KEY_STEP : width + KEY_STEP, limits)
    case 'Home': return limits.min
    case 'End': return limits.max
    default: return null
  }
}
