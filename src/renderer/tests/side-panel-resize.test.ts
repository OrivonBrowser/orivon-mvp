import { describe, expect, it } from 'vitest'
import { KEY_STEP, widthFromDrag, widthFromKey } from '../overlay/side-panel/resize.js'

const LIMITS = { min: 280, max: 640, reset: 360 }

describe('widthFromDrag', () => {
  it('widens a right-hand panel as the pointer moves toward the page', () => {
    expect(widthFromDrag(360, 900, 820, 'right', LIMITS)).toBe(440)
    expect(widthFromDrag(360, 900, 950, 'right', LIMITS)).toBe(310)
  })

  it('widens a left-hand panel as the pointer moves toward the page, which is the other way', () => {
    expect(widthFromDrag(360, 360, 440, 'left', LIMITS)).toBe(440)
    expect(widthFromDrag(360, 360, 310, 'left', LIMITS)).toBe(310)
  })

  it('stays within the limits and whole pixels', () => {
    expect(widthFromDrag(360, 900, 100, 'right', LIMITS)).toBe(640)
    expect(widthFromDrag(360, 900, 1500, 'right', LIMITS)).toBe(280)
    expect(widthFromDrag(360, 900.4, 820, 'right', LIMITS)).toBe(440)
  })
})

describe('widthFromKey', () => {
  it('moves by a step toward the page to widen, whichever side the panel is on', () => {
    expect(widthFromKey('ArrowLeft', 360, 'right', LIMITS)).toBe(360 + KEY_STEP)
    expect(widthFromKey('ArrowRight', 360, 'right', LIMITS)).toBe(360 - KEY_STEP)
    expect(widthFromKey('ArrowRight', 360, 'left', LIMITS)).toBe(360 + KEY_STEP)
    expect(widthFromKey('ArrowLeft', 360, 'left', LIMITS)).toBe(360 - KEY_STEP)
  })

  it('takes three presses from the default to 408', () => {
    let width = 360
    for (let press = 0; press < 3; press += 1) width = widthFromKey('ArrowLeft', width, 'right', LIMITS) ?? width
    expect(width).toBe(408)
  })

  it('jumps to the limits on Home and End', () => {
    expect(widthFromKey('Home', 400, 'right', LIMITS)).toBe(280)
    expect(widthFromKey('End', 400, 'left', LIMITS)).toBe(640)
  })

  it('holds at the limits, and ignores other keys', () => {
    expect(widthFromKey('ArrowLeft', 640, 'right', LIMITS)).toBe(640)
    expect(widthFromKey('ArrowRight', 280, 'right', LIMITS)).toBe(280)
    expect(widthFromKey('a', 400, 'right', LIMITS)).toBeNull()
    expect(widthFromKey('ArrowUp', 400, 'right', LIMITS)).toBeNull()
  })
})
