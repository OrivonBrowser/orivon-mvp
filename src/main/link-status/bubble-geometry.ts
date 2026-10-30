// Where the link bubble sits: pure geometry, no view involved. The bubble is one line high and as wide as its text
// (a view blocks the pointer over its whole rectangle, so spare width would deaden the links under it), flush in the
// bottom corner of the page the link is in.
import type { BubbleInset, BubbleSide } from './link-status-view.js'
import type { OverlayAnchor } from '../overlays/overlay-types.js'

export const BUBBLE_HEIGHT = 24
/** The view's own corner radius. Only the corner away from the window's edges is on screen; the others reach past the edge. */
export const BUBBLE_RADIUS = 6
export const BUBBLE_MAX_WIDTH = 600
export const BUBBLE_MIN_WIDTH = 40

/** Window pixels: the page area of one tab. */
export interface PaneRect { readonly x: number, readonly y: number, readonly width: number, readonly height: number }
export interface WindowSize { readonly width: number, readonly height: number }

export interface BubblePlace {
  /** The view's rectangle: the visible part and the inset past the window's edges. */
  readonly bounds: OverlayAnchor
  readonly inset: BubbleInset
}

/** One pixel of slack, for a window whose content size is not a whole number. */
const EDGE_SLACK = 1

/** The most a bubble in this pane may be wide: the cap, or half the pane when that is less. Nothing in a pane too narrow for a bubble. */
export function bubbleRoom (pane: PaneRect): number | undefined {
  const room = Math.min(BUBBLE_MAX_WIDTH, Math.floor(pane.width / 2))
  return room < BUBBLE_MIN_WIDTH ? undefined : room
}

/** The width a bubble gets for a text that measured `wanted` wide: at most its room, at least the floor. */
export function bubbleWidth (wanted: number, pane: PaneRect): number | undefined {
  const room = bubbleRoom(pane)
  if (room === undefined) return undefined
  const asked = Number.isNaN(wanted) ? BUBBLE_MIN_WIDTH : Math.ceil(wanted)
  return Math.max(BUBBLE_MIN_WIDTH, Math.min(asked, room))
}

/** The insets a bubble of this pane and side has: a corner is reached past only where the pane's edge is the window's. */
export function bubbleInset (pane: PaneRect, window: WindowSize, side: BubbleSide): BubbleInset {
  const atLeft = pane.x <= EDGE_SLACK
  const atRight = pane.x + pane.width >= window.width - EDGE_SLACK
  const atBottom = pane.y + pane.height >= window.height - EDGE_SLACK
  return {
    left: side === 'left' && atLeft ? BUBBLE_RADIUS : 0,
    right: side === 'right' && atRight ? BUBBLE_RADIUS : 0,
    bottom: atBottom ? BUBBLE_RADIUS : 0
  }
}

/** Where a bubble `wanted` wide goes in the corner of `pane`, or nothing when the pane is too narrow. */
export function bubblePlace (pane: PaneRect, window: WindowSize, side: BubbleSide, wanted: number): BubblePlace | undefined {
  const width = bubbleWidth(wanted, pane)
  if (width === undefined) return undefined
  const inset = bubbleInset(pane, window, side)
  const visibleX = side === 'left' ? pane.x : pane.x + pane.width - width
  const bottom = pane.y + pane.height
  return {
    inset,
    bounds: { x: visibleX - inset.left, y: bottom - BUBBLE_HEIGHT, width: width + inset.left + inset.right, height: BUBBLE_HEIGHT + inset.bottom }
  }
}

/** A place of no size in the corner the bubble will take: where its view is first shown, while its page measures the text. */
export function hiddenBounds (pane: PaneRect, side: BubbleSide): OverlayAnchor {
  return { x: side === 'left' ? pane.x : pane.x + pane.width, y: pane.y + pane.height - BUBBLE_HEIGHT, width: 0, height: 0 }
}
