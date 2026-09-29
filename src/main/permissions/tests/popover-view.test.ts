import { describe, expect, it } from 'vitest'
import { popoverBounds } from '../popover-view.js'
import type { PopoverAnchor } from '../popover-view.js'

const win = (width: number, height: number): { getContentBounds: () => { width: number, height: number } } =>
  ({ getContentBounds: () => ({ width, height }) })

const ANCHOR: PopoverAnchor = { x: 900, y: 40, width: 30, height: 30 }

describe('popoverBounds', () => {
  it('sizes to its content when that fits under a fixed cap and the window has room', () => {
    const bounds = popoverBounds(win(1200, 800) as never, ANCHOR, 'right', 300, 460)
    expect(bounds.height).toBe(300)
  })

  it('caps a long list at its fixed maxHeight even though the window has room to spare', () => {
    const bounds = popoverBounds(win(1200, 800) as never, ANCHOR, 'right', 900, 460)
    expect(bounds.height).toBe(460)
  })

  it('with an unbounded maxHeight, shows the whole list instead -- the menu\'s own case', () => {
    const bounds = popoverBounds(win(1200, 800) as never, ANCHOR, 'right', 509, Number.POSITIVE_INFINITY)
    expect(bounds.height).toBe(509)
  })

  it('never grows past the room below the anchor, whatever maxHeight allows', () => {
    // Anchor near the bottom of a short window: not much room left under it.
    const shortWin = win(1200, 200)
    const lowAnchor: PopoverAnchor = { x: 900, y: 150, width: 30, height: 30 }
    const bounds = popoverBounds(shortWin as never, lowAnchor, 'right', 509, Number.POSITIVE_INFINITY)
    expect(bounds.height).toBeLessThan(509)
    expect(bounds.height).toBeGreaterThanOrEqual(120) // MIN_HEIGHT
  })
})
