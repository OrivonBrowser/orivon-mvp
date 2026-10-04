import { GAP } from '../../overlays/overlay-bounds.js'
import { slotAnchorsMoved } from '../../overlays/tab-slots.js'
import type { OverlayAnchor } from '../../overlays/overlay-types.js'
import type { ChromeAction } from '../chrome-actions.js'
import type { ShellWindow } from '../window-registry.js'

// Window-content pixels; a real toolbar rectangle is far inside these.
const MAX_EXTENT = 10_000

const reported = new WeakMap<ShellWindow, OverlayAnchor>()

function isAnchor (value: unknown): value is OverlayAnchor {
  if (typeof value !== 'object' || value === null) return false
  const { x, y, width, height } = value as Record<string, unknown>
  const finite = (n: unknown, low: number): n is number => typeof n === 'number' && Number.isFinite(n) && n >= low && n <= MAX_EXTENT
  return finite(x, -MAX_EXTENT) && finite(y, -MAX_EXTENT) && finite(width, 1) && finite(height, 1)
}

/** The chrome reports where the address pill is whenever it moves, so a prompt can open under it without
 * asking the chrome at that moment. The payload is the rectangle; anything else is ignored. */
export const promptAnchorReport: ChromeAction = (payload, { window }) => {
  if (!isAnchor(payload)) return
  const before = reported.get(window)
  reported.set(window, { x: payload.x, y: payload.y, width: payload.width, height: payload.height })
  // A prompt already under the pill follows it: a window resized or a button shown beside the pill moves it.
  if (before !== undefined) slotAnchorsMoved(window)
}

/** Where the address pill is, as the chrome last reported it, or undefined before the first report. */
export function promptAnchor (window: ShellWindow): OverlayAnchor | undefined {
  return reported.get(window)
}

/** How far a question reaches up into the toolbar from the pill's bottom edge: past the line page content can never draw over. */
export const TOOLBAR_OVERLAP = 8

/**
 * The rectangle to anchor a prompt to so that its top edge sits TOOLBAR_OVERLAP inside the address pill instead of
 * below it. A page can draw a look-alike prompt only inside its own area, so a prompt that starts in the toolbar
 * cannot be copied edge to edge. Undefined before the chrome's first report.
 */
export function crossingAnchor (window: ShellWindow): OverlayAnchor | undefined {
  const pill = reported.get(window)
  return pill === undefined ? undefined : { ...pill, height: pill.height - TOOLBAR_OVERLAP - GAP }
}
