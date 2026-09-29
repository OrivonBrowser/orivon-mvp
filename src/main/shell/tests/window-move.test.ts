import { describe, expect, it } from 'vitest'
import { edgeZoneFor, grabFor, halfOfWorkArea, positionFor, restorePositionFor } from '../window-move.js'

describe('grabFor / positionFor', () => {
  it('keeps the window under the same place the pointer grabbed it as it moves', () => {
    const bounds = { x: 100, y: 50, width: 800, height: 600 }
    const grab = grabFor({ x: 140, y: 70 }, bounds)
    expect(grab).toEqual({ dx: 40, dy: 20, proportionX: 40 / 800 })

    expect(positionFor({ x: 140, y: 70 }, grab)).toEqual({ x: 100, y: 50 })
    expect(positionFor({ x: 240, y: 170 }, grab)).toEqual({ x: 200, y: 150 })
  })

  it('proportionX is zero for a zero-width window rather than dividing by zero', () => {
    expect(grabFor({ x: 10, y: 10 }, { x: 10, y: 10, width: 0, height: 0 }).proportionX).toBe(0)
  })
})

describe('restorePositionFor', () => {
  it('keeps the pointer at the same horizontal share of the window once it restores to a different width', () => {
    const maximized = { x: 0, y: 0, width: 1600, height: 900 }
    const grab = grabFor({ x: 800, y: 20 }, maximized) // grabbed exactly at the horizontal midpoint
    expect(grab.proportionX).toBeCloseTo(0.5)

    const restoredWidth = 800
    const to = restorePositionFor({ x: 800, y: 20 }, restoredWidth, grab)
    // The pointer should again sit at the midpoint of the now-narrower window.
    expect(to.x).toBe(Math.round(800 - restoredWidth * 0.5))
  })
})

describe('edgeZoneFor', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 }

  it('maximizes only right at the top edge', () => {
    expect(edgeZoneFor({ x: 900, y: 1 }, workArea)).toBe('maximize')
    // A top-aligned window (already flush with the edge, the common case just after a tile) can
    // still be dragged sideways: a release a few pixels down is no longer "the top edge".
    expect(edgeZoneFor({ x: 900, y: 5 }, workArea)).toBeNull()
  })

  it('tiles left or right only right at those edges', () => {
    expect(edgeZoneFor({ x: 1, y: 500 }, workArea)).toBe('left')
    expect(edgeZoneFor({ x: 1919, y: 500 }, workArea)).toBe('right')
    expect(edgeZoneFor({ x: 2, y: 500 }, workArea)).toBeNull()
    expect(edgeZoneFor({ x: 1917, y: 500 }, workArea)).toBeNull()
  })

  it('is nothing away from every edge', () => {
    expect(edgeZoneFor({ x: 900, y: 500 }, workArea)).toBeNull()
  })

  it('the top edge wins a corner', () => {
    expect(edgeZoneFor({ x: 1, y: 1 }, workArea)).toBe('maximize')
  })
})

describe('halfOfWorkArea', () => {
  it('splits the work area in two, left and right', () => {
    const workArea = { x: 100, y: 0, width: 1000, height: 800 }
    expect(halfOfWorkArea(workArea, 'left')).toEqual({ x: 100, y: 0, width: 500, height: 800 })
    expect(halfOfWorkArea(workArea, 'right')).toEqual({ x: 600, y: 0, width: 500, height: 800 })
  })
})
