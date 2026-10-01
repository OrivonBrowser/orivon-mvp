import { describe, expect, it } from 'vitest'
import { placementFor } from '../placement.js'

const screen = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } }
const left = { bounds: { x: -1280, y: 0, width: 1280, height: 1024 } }
const saved = (x: number, y: number, width: number, height: number, maximized = false): { bounds: { x: number, y: number, width: number, height: number }, maximized: boolean } => ({ bounds: { x, y, width, height }, maximized })

describe('placementFor', () => {
  it('opens at the default place when nothing was saved', () => {
    expect(placementFor(null, [screen])).toEqual({ maximized: false })
  })

  it('restores a place that is on a display', () => {
    expect(placementFor(saved(100, 80, 900, 620), [screen])).toEqual({ place: { x: 100, y: 80, width: 900, height: 620 }, maximized: false })
  })

  it('restores onto a second monitor that sits at a negative origin', () => {
    expect(placementFor(saved(-1200, 40, 1000, 700), [screen, left])).toEqual({ place: { x: -1200, y: 40, width: 1000, height: 700 }, maximized: false })
  })

  it('drops a place that is on no display any more, as after a monitor is unplugged', () => {
    expect(placementFor(saved(-1200, 40, 1000, 700), [screen])).toEqual({ maximized: false })
    expect(placementFor(saved(50_000, 0, 900, 620), [screen])).toEqual({ maximized: false })
  })

  it('needs enough of the top strip on a display to grab the window', () => {
    expect(placementFor(saved(1900, 100, 900, 620), [screen])).toEqual({ maximized: false })
    expect(placementFor(saved(1800, 100, 900, 620), [screen]).place).toBeDefined()
    expect(placementFor(saved(100, -30, 900, 620), [screen])).toEqual({ maximized: false })
    expect(placementFor(saved(100, 1060, 900, 620), [screen])).toEqual({ maximized: false })
  })

  it('reduces a size larger than the display to it, and moves the window to fit', () => {
    expect(placementFor(saved(500, 400, 4000, 3000), [screen]).place).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
  })

  it('keeps a window whose size fits but which hangs past the edge on the screen', () => {
    expect(placementFor(saved(1500, 700, 900, 620), [screen]).place).toEqual({ x: 1020, y: 460, width: 900, height: 620 })
  })

  it('never makes a window smaller than 480 by 320', () => {
    expect(placementFor(saved(100, 100, 50, 20), [screen]).place).toMatchObject({ width: 480, height: 320 })
  })

  it('measures against the display the window is on, not another', () => {
    const small = { bounds: { x: 1920, y: 0, width: 800, height: 600 } }
    expect(placementFor(saved(2000, 50, 1600, 900), [screen, small]).place).toEqual({ x: 1920, y: 0, width: 800, height: 600 })
  })

  it('still opens maximised when the place is gone', () => {
    expect(placementFor(saved(50_000, 0, 900, 620, true), [screen])).toEqual({ maximized: true })
    expect(placementFor(saved(100, 80, 900, 620, true), [screen])).toEqual({ place: { x: 100, y: 80, width: 900, height: 620 }, maximized: true })
  })

  it('refuses numbers that are not numbers', () => {
    expect(placementFor(saved(Number.NaN, 0, 900, 620), [screen])).toEqual({ maximized: false })
    expect(placementFor(saved(0, 0, Infinity, 620), [screen])).toEqual({ maximized: false })
    expect(placementFor(saved(0, 0, 0, 620), [screen])).toEqual({ maximized: false })
  })

  it('has no display to open on', () => {
    expect(placementFor(saved(100, 100, 900, 620), [])).toEqual({ maximized: false })
  })
})
