import { describe, expect, it } from 'vitest'
import { popupBounds, POPUP_GAP, POPUP_MARGIN } from '../extension-popup-geometry.js'

const content = { width: 1000, height: 700 }
const anchor = { x: 900, y: 40, width: 30, height: 30 }

describe('popupBounds', () => {
  it('puts the popup under the anchor with its right edge on the anchor\'s', () => {
    expect(popupBounds({ anchor, size: { width: 300, height: 200 }, content })).toEqual({
      x: 900 + 30 - 300, y: 40 + 30 + POPUP_GAP, width: 300, height: 200
    })
  })

  it('keeps the right edge when the popup grows', () => {
    const small = popupBounds({ anchor, size: { width: 100, height: 100 }, content })
    const large = popupBounds({ anchor, size: { width: 400, height: 100 }, content })
    expect(small.x + small.width).toBe(930)
    expect(large.x + large.width).toBe(930)
  })

  it('puts the left edge on the anchor\'s with right alignment', () => {
    expect(popupBounds({ anchor, alignment: 'right', size: { width: 50, height: 50 }, content }).x).toBe(900)
  })

  it('puts the popup above the anchor with top alignment', () => {
    const bounds = popupBounds({ anchor: { ...anchor, y: 300 }, alignment: 'top', size: { width: 50, height: 100 }, content })
    expect(bounds.y).toBe(300 - 100 - POPUP_GAP)
  })

  it('stays the margin inside the left edge', () => {
    const bounds = popupBounds({ anchor: { x: 20, y: 40, width: 30, height: 30 }, size: { width: 300, height: 100 }, content })
    expect(bounds.x).toBe(POPUP_MARGIN)
  })

  it('stays the margin inside the right edge', () => {
    const bounds = popupBounds({ anchor: { x: 990, y: 40, width: 30, height: 30 }, size: { width: 100, height: 100 }, content })
    expect(bounds.x + bounds.width).toBe(1000 - POPUP_MARGIN)
  })

  it('caps the width at the content width less both margins', () => {
    const bounds = popupBounds({ anchor, size: { width: 800, height: 100 }, content: { width: 500, height: 700 } })
    expect(bounds.width).toBe(500 - 2 * POPUP_MARGIN)
    expect(bounds.x).toBe(POPUP_MARGIN)
  })

  it('caps the height at the room below the anchor', () => {
    const bounds = popupBounds({ anchor, size: { width: 300, height: 650 }, content })
    expect(bounds.y + bounds.height).toBe(700 - POPUP_MARGIN)
    expect(bounds.height).toBe(700 - POPUP_MARGIN - (40 + 30 + POPUP_GAP))
  })

  it('keeps a popup that fits exactly where it was asked to be', () => {
    const bounds = popupBounds({ anchor, size: { width: 200, height: 100 }, content })
    expect(bounds.height).toBe(100)
  })

  it('never returns a negative size in a tiny window', () => {
    const bounds = popupBounds({ anchor: { x: 0, y: 0, width: 10, height: 10 }, size: { width: 300, height: 300 }, content: { width: 10, height: 10 } })
    expect(bounds.width).toBeGreaterThanOrEqual(0)
    expect(bounds.height).toBeGreaterThanOrEqual(0)
  })
})
