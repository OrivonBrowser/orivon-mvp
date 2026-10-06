// Where an extension's popup sits inside its window: under the toolbar rectangle that opened it, its right edge on
// that rectangle's, never closer than a margin to the window's edges. All in the window's content coordinates, which
// the chrome view shares (it sits unzoomed at 0,0), so an anchor measured in the chrome page needs no conversion.
// No electron import: the placement is a pure function of five numbers.
import type { Rectangle } from 'electron'

export const POPUP_GAP = 5
export const POPUP_MARGIN = 8

export interface PopupGeometryInput {
  readonly anchor: Rectangle
  /** `'right'` puts the popup's left edge on the anchor's, `'top'` puts it above the anchor. */
  readonly alignment?: string | undefined
  readonly size: { readonly width: number, readonly height: number }
  readonly content: { readonly width: number, readonly height: number }
}

export function popupBounds ({ anchor, alignment, size, content }: PopupGeometryInput): Rectangle {
  const width = Math.max(0, Math.min(size.width, content.width - 2 * POPUP_MARGIN))
  const rawX = alignment?.includes('right') === true ? anchor.x : anchor.x + anchor.width - width
  const x = clamp(rawX, POPUP_MARGIN, content.width - POPUP_MARGIN - width)

  const above = alignment?.includes('top') === true
  const room = above ? anchor.y - POPUP_GAP - POPUP_MARGIN : content.height - POPUP_MARGIN - (anchor.y + anchor.height + POPUP_GAP)
  const height = Math.max(0, Math.min(size.height, room))
  const rawY = above ? anchor.y - height - POPUP_GAP : anchor.y + anchor.height + POPUP_GAP
  const y = clamp(rawY, POPUP_MARGIN, content.height - POPUP_MARGIN - height)

  return { x: Math.floor(x), y: Math.floor(y), width: Math.floor(width), height: Math.floor(height) }
}

function clamp (value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, Math.max(low, high)))
}
