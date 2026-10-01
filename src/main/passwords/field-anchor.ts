// Where a box the page reports is in the window: the tab view's own place plus the box's rectangle, scaled by
// how wide the page said it was against how wide the view is (that ratio is the page zoom, whatever way the
// shell applies it). Pure: no `electron` import.
import type { OverlayAnchor } from '../overlays/overlay-types.js'
import type { FieldRect } from './form-message.js'

/** The box in window-content pixels, or undefined when it is not inside the view: a box scrolled out of sight has no place to hang a chooser from. */
export function fieldAnchor (view: { x: number, y: number, width: number, height: number }, field: { rect: FieldRect, viewWidth: number }): OverlayAnchor | undefined {
  if (!(field.viewWidth > 0) || !(view.width > 0)) return undefined
  const scale = view.width / field.viewWidth
  const x = view.x + field.rect.x * scale
  const y = view.y + field.rect.y * scale
  const width = field.rect.width * scale
  const height = field.rect.height * scale
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return undefined
  const inside = x + width > view.x && x < view.x + view.width && y + height > view.y && y < view.y + view.height
  return inside ? { x, y, width, height } : undefined
}
