import { describe, expect, it } from 'vitest'
import { overlayBounds } from '../overlay-bounds.js'
import type { OverlayFrame } from '../overlay-bounds.js'

const FRAME: OverlayFrame = { width: 1200, height: 800, area: { x: 0, y: 76, width: 1200, height: 724 } }
const LIMITS = { min: 120, max: 460 }
const BUTTON = { x: 900, y: 40, width: 30, height: 30 }

describe('overlayBounds: anchor', () => {
  it('right-aligns to the anchor and sits GAP under it', () => {
    expect(overlayBounds({ kind: 'anchor', width: 380, align: 'right' }, BUTTON, FRAME, 300, LIMITS))
      .toEqual({ x: 550, y: 76, width: 380, height: 300 })
  })

  it('left-aligns to the anchor', () => {
    expect(overlayBounds({ kind: 'anchor', width: 380, align: 'left' }, { ...BUTTON, x: 100 }, FRAME, 300, LIMITS).x).toBe(100)
  })

  it('centres on the anchor', () => {
    expect(overlayBounds({ kind: 'anchor', width: 200, align: 'center' }, BUTTON, FRAME, 300, LIMITS).x).toBe(815)
  })

  it('keeps EDGE to the right window edge', () => {
    const rect = overlayBounds({ kind: 'anchor', width: 380, align: 'left' }, { x: 1190, y: 40, width: 10, height: 30 }, FRAME, 300, LIMITS)
    expect(rect.x).toBe(1200 - 380 - 8)
  })

  it('keeps EDGE to the left window edge', () => {
    expect(overlayBounds({ kind: 'anchor', width: 380, align: 'right' }, { x: 0, y: 40, width: 10, height: 30 }, FRAME, 300, LIMITS).x).toBe(8)
  })

  it('narrows to the window when the window is narrower than the placement', () => {
    const rect = overlayBounds({ kind: 'anchor', width: 380, align: 'right' }, BUTTON, { ...FRAME, width: 300 }, 300, LIMITS)
    expect(rect.width).toBe(284)
    expect(rect.x).toBe(8)
  })

  it('without a rectangle hangs off the right end, under the chrome', () => {
    const rect = overlayBounds({ kind: 'anchor', width: 380, align: 'right' }, undefined, FRAME, 300, LIMITS)
    expect(rect).toEqual({ x: 1200 - 8 - 380, y: 76, width: 380, height: 300 })
  })

  it('without a rectangle, a left-aligned overlay is still pulled inside the right edge', () => {
    expect(overlayBounds({ kind: 'anchor', width: 380, align: 'left' }, undefined, FRAME, 300, LIMITS).x).toBe(1200 - 380 - 8)
  })
})

describe('overlayBounds: anchor-width', () => {
  it('sits under the rect at its own width, with the tighter gap', () => {
    expect(overlayBounds({ kind: 'anchor-width' }, { x: 200, y: 40, width: 600, height: 30 }, FRAME, 200, LIMITS))
      .toEqual({ x: 200, y: 74, width: 600, height: 200 })
  })

  it('never wider than the window minus its margins', () => {
    const rect = overlayBounds({ kind: 'anchor-width' }, { x: 0, y: 40, width: 5000, height: 30 }, FRAME, 200, LIMITS)
    expect(rect.width).toBe(1184)
    expect(rect.x).toBe(8)
  })

  it('without a rectangle spans the window under the chrome', () => {
    const rect = overlayBounds({ kind: 'anchor-width' }, undefined, FRAME, 200, LIMITS)
    expect(rect).toEqual({ x: 8, y: 76, width: 1184, height: 200 })
  })
})

describe('overlayBounds: area', () => {
  it('top-right insets 16 from the right and 8 from the top of the tab area', () => {
    expect(overlayBounds({ kind: 'area', at: 'top-right', width: 360 }, undefined, FRAME, 100, LIMITS))
      .toEqual({ x: 1200 - 360 - 16, y: 84, width: 360, height: 120 })
  })

  it('top-center centres in the tab area', () => {
    const rect = overlayBounds({ kind: 'area', at: 'top-center', width: 520 }, undefined, FRAME, 300, LIMITS)
    expect(rect).toEqual({ x: 340, y: 84, width: 520, height: 300 })
  })

  it('centres on the area, including its vertical position', () => {
    const rect = overlayBounds({ kind: 'area', at: 'center', width: 400 }, undefined, FRAME, 300, LIMITS)
    expect(rect).toEqual({ x: 400, y: 76 + (724 - 300) / 2, width: 400, height: 300 })
  })

  it('follows a docked area that does not start at x 0', () => {
    const docked = { ...FRAME, area: { x: 0, y: 76, width: 900, height: 724 } }
    expect(overlayBounds({ kind: 'area', at: 'top-right', width: 360 }, undefined, docked, 200, LIMITS).x).toBe(900 - 360 - 16)
  })

  it('narrows to the window', () => {
    const rect = overlayBounds({ kind: 'area', at: 'top-center', width: 520 }, undefined, { ...FRAME, width: 400, area: { x: 0, y: 76, width: 400, height: 700 } }, 200, LIMITS)
    expect(rect.width).toBe(384)
    expect(rect.x).toBe(8)
  })

  it('ignores an anchor', () => {
    const rect = overlayBounds({ kind: 'area', at: 'top-right', width: 360 }, BUTTON, FRAME, 200, LIMITS)
    expect(rect.x).toBe(1200 - 360 - 16)
  })

  it('a centred overlay taller than the area is held to the area minus its margins', () => {
    const short = { ...FRAME, area: { x: 0, y: 76, width: 1200, height: 300 } }
    const rect = overlayBounds({ kind: 'area', at: 'center', width: 400 }, undefined, short, 900, { min: 120, max: 2000 })
    expect(rect.height).toBe(284)
    expect(rect.y).toBe(84)
  })
})

describe('overlayBounds: height', () => {
  const placement = { kind: 'anchor', width: 380, align: 'right' } as const

  it('sizes to content within the limits', () => {
    expect(overlayBounds(placement, BUTTON, FRAME, 250, LIMITS).height).toBe(250)
  })

  it('caps at max', () => {
    expect(overlayBounds(placement, BUTTON, FRAME, 900, LIMITS).height).toBe(460)
  })

  it('floors at min', () => {
    expect(overlayBounds(placement, BUTTON, FRAME, 10, LIMITS).height).toBe(120)
  })

  it('is bounded by the room under the anchor, above the max', () => {
    const rect = overlayBounds(placement, { x: 900, y: 500, width: 30, height: 30 }, FRAME, 900, { min: 120, max: 2000 })
    expect(rect.y).toBe(536)
    expect(rect.height).toBe(800 - 536 - 8)
  })

  it('the min floor wins over an almost-absent room', () => {
    expect(overlayBounds(placement, { x: 900, y: 760, width: 30, height: 30 }, FRAME, 300, LIMITS).height).toBe(120)
  })

  it('treats a non-finite height as the floor', () => {
    expect(overlayBounds(placement, BUTTON, FRAME, Number.NaN, LIMITS).height).toBe(120)
    expect(overlayBounds(placement, BUTTON, FRAME, Number.POSITIVE_INFINITY, LIMITS).height).toBe(120)
  })

  it('rounds to whole pixels', () => {
    expect(overlayBounds(placement, { x: 900.4, y: 40.2, width: 30, height: 30 }, FRAME, 250.6, LIMITS)).toMatchObject({ y: 76, height: 251 })
  })
})
