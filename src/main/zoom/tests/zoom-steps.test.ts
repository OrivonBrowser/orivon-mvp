import { describe, expect, it } from 'vitest'
import { MAX_ZOOM_PERCENT, MIN_ZOOM_PERCENT, ZOOM_PERCENTS, isZoomPercent, stepPercent } from '../zoom-steps.js'

describe('zoom steps', () => {
  it('go up and down the presets from any preset', () => {
    expect(stepPercent(100, 'in')).toBe(110)
    expect(stepPercent(100, 'out')).toBe(90)
    for (const [at, percent] of ZOOM_PERCENTS.entries()) {
      if (at > 0) expect(stepPercent(percent, 'out')).toBe(ZOOM_PERCENTS[at - 1])
      if (at < ZOOM_PERCENTS.length - 1) expect(stepPercent(percent, 'in')).toBe(ZOOM_PERCENTS[at + 1])
    }
  })

  it('stop at the smallest and the largest level', () => {
    expect(stepPercent(MAX_ZOOM_PERCENT, 'in')).toBe(MAX_ZOOM_PERCENT)
    expect(stepPercent(MIN_ZOOM_PERCENT, 'out')).toBe(MIN_ZOOM_PERCENT)
  })

  it('take a level between presets to the next preset in the direction asked', () => {
    expect(stepPercent(105, 'in')).toBe(110)
    expect(stepPercent(105, 'out')).toBe(100)
  })

  it('accept only a whole percent within the range', () => {
    for (const bad of [24, 501, 100.5, Number.NaN, '100', null, undefined]) expect(isZoomPercent(bad), String(bad)).toBe(false)
    for (const good of [25, 100, 500]) expect(isZoomPercent(good)).toBe(true)
  })
})
