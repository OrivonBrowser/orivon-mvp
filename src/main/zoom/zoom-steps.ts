// The zoom levels a person steps through: the same presets the major browsers
// offer, as whole percents. Pure.

export const ZOOM_PERCENTS: readonly number[] = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500]

export const MIN_ZOOM_PERCENT = 25
export const MAX_ZOOM_PERCENT = 500

/** Whether `value` is a level the store may hold: a whole percent within the range. */
export function isZoomPercent (value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_ZOOM_PERCENT && value <= MAX_ZOOM_PERCENT
}

/** The next preset above or below `percent`; a level between presets goes to the nearer preset in that direction. */
export function stepPercent (percent: number, direction: 'in' | 'out'): number {
  if (direction === 'in') return ZOOM_PERCENTS.find((step) => step > percent) ?? MAX_ZOOM_PERCENT
  return [...ZOOM_PERCENTS].reverse().find((step) => step < percent) ?? MIN_ZOOM_PERCENT
}
