import { describe, expect, it } from 'vitest'
import { BUBBLE_HEIGHT, BUBBLE_MAX_WIDTH, BUBBLE_MIN_WIDTH, BUBBLE_RADIUS, bubblePlace, bubbleWidth, hiddenBounds } from '../bubble-geometry.js'

const WINDOW = { width: 1200, height: 800 }
const FULL = { x: 0, y: 76, width: 1200, height: 724 }
const R = BUBBLE_RADIUS
const H = BUBBLE_HEIGHT

describe('bubbleWidth', () => {
  it('keeps a width that fits', () => {
    expect(bubbleWidth(240, FULL)).toBe(240)
  })

  it('rounds up to a whole pixel, so the text never meets the edge', () => {
    expect(bubbleWidth(240.2, FULL)).toBe(241)
  })

  it('stops at the cap however wide the pane is', () => {
    expect(bubbleWidth(2000, FULL)).toBe(BUBBLE_MAX_WIDTH)
  })

  it('stops at half the pane when that is less than the cap', () => {
    expect(bubbleWidth(2000, { ...FULL, width: 800 })).toBe(400)
  })

  it('holds a floor under a text that measured as nothing', () => {
    expect(bubbleWidth(0, FULL)).toBe(BUBBLE_MIN_WIDTH)
    expect(bubbleWidth(-30, FULL)).toBe(BUBBLE_MIN_WIDTH)
    expect(bubbleWidth(Number.NaN, FULL)).toBe(BUBBLE_MIN_WIDTH)
    expect(bubbleWidth(Number.POSITIVE_INFINITY, FULL)).toBe(BUBBLE_MAX_WIDTH)
  })

  it('shows nothing in a pane too narrow for a bubble that is at most half of it', () => {
    expect(bubbleWidth(100, { ...FULL, width: BUBBLE_MIN_WIDTH * 2 - 1 })).toBeUndefined()
    expect(bubbleWidth(100, { ...FULL, width: BUBBLE_MIN_WIDTH * 2 })).toBe(BUBBLE_MIN_WIDTH)
  })
})

describe('bubblePlace: the window has one pane', () => {
  it('sits in the bottom-left corner of the page, with the rounded corners that are not the top one off the window', () => {
    const place = bubblePlace(FULL, WINDOW, 'left', 240)
    expect(place?.inset).toEqual({ left: R, right: 0, bottom: R })
    expect(place?.bounds).toEqual({ x: -R, y: 800 - H, width: 240 + R, height: H + R })
  })

  it('flipped, sits in the bottom-right corner', () => {
    const place = bubblePlace(FULL, WINDOW, 'right', 240)
    expect(place?.inset).toEqual({ left: 0, right: R, bottom: R })
    expect(place?.bounds).toEqual({ x: 1200 - 240, y: 800 - H, width: 240 + R, height: H + R })
  })

  it('keeps its visible part inside the page', () => {
    for (const side of ['left', 'right'] as const) {
      const place = bubblePlace(FULL, WINDOW, side, 300)
      if (place === undefined) throw new Error('no place')
      const visibleLeft = place.bounds.x + place.inset.left
      const visibleRight = place.bounds.x + place.bounds.width - place.inset.right
      expect(visibleLeft).toBeGreaterThanOrEqual(FULL.x)
      expect(visibleRight).toBeLessThanOrEqual(FULL.x + FULL.width)
      expect(visibleRight - visibleLeft).toBe(300)
    }
  })

  it('is one line high above the bottom edge of the page', () => {
    const place = bubblePlace(FULL, WINDOW, 'left', 240)
    expect((place?.bounds.y ?? 0) + (place?.bounds.height ?? 0) - (place?.inset.bottom ?? 0)).toBe(FULL.y + FULL.height)
    expect(H).toBeGreaterThanOrEqual(24)
    expect(H).toBeLessThanOrEqual(26)
  })

  it('shows nothing in a pane too narrow', () => {
    expect(bubblePlace({ ...FULL, width: 60 }, WINDOW, 'left', 100)).toBeUndefined()
  })

  it('clamps a wanted width before it places', () => {
    expect(bubblePlace(FULL, WINDOW, 'left', 5000)?.bounds.width).toBe(BUBBLE_MAX_WIDTH + R)
  })
})

describe('bubblePlace: a split window', () => {
  const left = { x: 0, y: 76, width: 596, height: 724 }
  const right = { x: 604, y: 76, width: 596, height: 724 }

  it('sits in the corner of the pane the link is in, not of the window', () => {
    const place = bubblePlace(right, WINDOW, 'left', 200)
    expect(place?.bounds.x).toBe(604)
    expect(place?.inset).toEqual({ left: 0, right: 0, bottom: R })
  })

  it('does not reach into the neighbouring pane for its hidden corners', () => {
    expect(bubblePlace(right, WINDOW, 'left', 200)?.bounds.x).toBe(right.x)
    expect(bubblePlace(left, WINDOW, 'right', 200)?.bounds.x).toBe(left.x + left.width - 200)
    expect(bubblePlace(left, WINDOW, 'right', 200)?.inset.right).toBe(0)
  })

  it('flipped in the right pane, uses the window edge for its hidden corner', () => {
    const place = bubblePlace(right, WINDOW, 'right', 200)
    expect(place?.bounds).toEqual({ x: 1200 - 200, y: 800 - H, width: 200 + R, height: H + R })
  })

  it('limits the width to half of the narrow pane', () => {
    expect(bubblePlace(right, WINDOW, 'left', 5000)?.bounds.width).toBe(298)
  })
})

describe('bubblePlace: a page that does not end at the window\'s bottom', () => {
  it('has no hidden bottom corners to reach for', () => {
    const place = bubblePlace({ x: 0, y: 76, width: 1200, height: 600 }, WINDOW, 'left', 240)
    expect(place?.inset.bottom).toBe(0)
    expect(place?.bounds).toEqual({ x: -R, y: 676 - H, width: 240 + R, height: H })
  })
})

describe('hiddenBounds', () => {
  it('is a place of no size in the corner the bubble will take', () => {
    expect(hiddenBounds(FULL, 'left')).toEqual({ x: 0, y: 800 - H, width: 0, height: 0 })
    expect(hiddenBounds(FULL, 'right')).toEqual({ x: 1200, y: 800 - H, width: 0, height: 0 })
  })
})
