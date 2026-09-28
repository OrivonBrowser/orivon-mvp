import { describe, expect, it } from 'vitest'
import { TEAR_DISTANCE_PX, dropIndex, isTornOut } from '../tab-drag.js'

describe('dropIndex', () => {
  it('counts the tabs whose centre the pointer has passed', () => {
    const centres = [50, 150, 250]
    expect(dropIndex(centres, 10)).toBe(0)
    expect(dropIndex(centres, 100)).toBe(1)
    expect(dropIndex(centres, 200)).toBe(2)
    expect(dropIndex(centres, 900)).toBe(3)
  })

  it('is zero when there are no other tabs', () => {
    expect(dropIndex([], 500)).toBe(0)
  })
})

describe('isTornOut', () => {
  const view = { width: 1000, stripHeight: 36 }

  it('is not while the pointer stays near the strip', () => {
    expect(isTornOut({ x: 500, y: 18 }, view)).toBe(false)
    expect(isTornOut({ x: 500, y: 36 + TEAR_DISTANCE_PX }, view)).toBe(false)
    expect(isTornOut({ x: 500, y: -TEAR_DISTANCE_PX }, view)).toBe(false)
  })

  it('is once it is well below or above the strip, or outside the window', () => {
    expect(isTornOut({ x: 500, y: 36 + TEAR_DISTANCE_PX + 1 }, view)).toBe(true)
    expect(isTornOut({ x: 500, y: -TEAR_DISTANCE_PX - 1 }, view)).toBe(true)
    expect(isTornOut({ x: -1, y: 10 }, view)).toBe(true)
    expect(isTornOut({ x: 1001, y: 10 }, view)).toBe(true)
  })
})
