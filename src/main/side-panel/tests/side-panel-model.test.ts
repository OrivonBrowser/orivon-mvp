import { describe, expect, it } from 'vitest'
import { clampWidth, fits, insetsFor, MIN_WINDOW_WIDTH, PAGE_MIN, PANEL_DEFAULT, PANEL_MAX, PANEL_MIN } from '../side-panel-model.js'

describe('clampWidth', () => {
  it('keeps a width inside the panel limits', () => {
    expect(clampWidth(100, 1600)).toBe(PANEL_MIN)
    expect(clampWidth(360, 1600)).toBe(360)
    expect(clampWidth(900, 1600)).toBe(PANEL_MAX)
  })

  it('leaves the page at least its own minimum', () => {
    expect(clampWidth(640, 1000)).toBe(1000 - PAGE_MIN)
    expect(clampWidth(640, 900)).toBe(900 - PAGE_MIN)
  })

  it('lets the lower limit win in a window too small for both', () => {
    expect(clampWidth(500, 600)).toBe(PANEL_MIN)
  })

  it('rounds, and answers the default for what is not a number', () => {
    expect(clampWidth(400.6, 1600)).toBe(401)
    expect(clampWidth(Number.NaN, 1600)).toBe(PANEL_DEFAULT)
    expect(clampWidth(Number.POSITIVE_INFINITY, 1600)).toBe(PANEL_DEFAULT)
  })
})

describe('fits', () => {
  it('needs a window at least the minimum wide', () => {
    expect(fits(MIN_WINDOW_WIDTH)).toBe(true)
    expect(fits(MIN_WINDOW_WIDTH - 1)).toBe(false)
  })
})

describe('insetsFor', () => {
  const base = { open: true, side: 'right' as const, width: 360, windowWidth: 1280, fullscreen: false }

  it('takes the panel width from the side it is on', () => {
    expect(insetsFor(base)).toEqual({ left: 0, right: 360 })
    expect(insetsFor({ ...base, side: 'left' })).toEqual({ left: 360, right: 0 })
  })

  it('takes nothing while closed', () => {
    expect(insetsFor({ ...base, open: false })).toEqual({ left: 0, right: 0 })
  })

  it('takes nothing in HTML fullscreen, in a kiosk or in a narrow window', () => {
    expect(insetsFor({ ...base, fullscreen: true })).toEqual({ left: 0, right: 0 })
    expect(insetsFor({ ...base, kiosk: true })).toEqual({ left: 0, right: 0 })
    expect(insetsFor({ ...base, windowWidth: 700 })).toEqual({ left: 0, right: 0 })
  })

  it('clamps a stored width to the window', () => {
    expect(insetsFor({ ...base, width: 640, windowWidth: 800 })).toEqual({ left: 0, right: 320 })
  })
})
