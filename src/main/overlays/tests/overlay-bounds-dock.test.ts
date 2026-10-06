import { describe, expect, it } from 'vitest'
import { dockBounds, overlayBounds } from '../overlay-bounds.js'
import type { OverlayFrame } from '../overlay-bounds.js'

const LIMITS = { min: 120, max: 460 }
const frame = (area: OverlayFrame['area']): OverlayFrame => ({ width: 1200, height: 800, area })

describe('dockBounds', () => {
  it('takes the strip right of the page area, from the chrome down to the window bottom', () => {
    expect(dockBounds(frame({ x: 0, y: 104, width: 840, height: 696 }))).toEqual({ x: 840, y: 104, width: 360, height: 696 })
  })

  it('takes the strip left of the page area when the page starts after the window edge', () => {
    expect(dockBounds(frame({ x: 360, y: 76, width: 840, height: 724 }))).toEqual({ x: 0, y: 76, width: 360, height: 724 })
  })

  it('is zero wide when the page takes the whole window, so a hidden dock needs no state', () => {
    expect(dockBounds(frame({ x: 0, y: 0, width: 1200, height: 800 })).width).toBe(0)
    expect(dockBounds(frame({ x: 0, y: 76, width: 1210, height: 724 })).width).toBe(0)
  })
})

describe('overlayBounds: dock', () => {
  it('ignores the content height and the limits: the window decides the size', () => {
    const area = { x: 0, y: 76, width: 840, height: 724 }
    expect(overlayBounds({ kind: 'dock' }, undefined, frame(area), 9999, LIMITS)).toEqual({ x: 840, y: 76, width: 360, height: 724 })
    expect(overlayBounds({ kind: 'dock' }, { x: 1, y: 2, width: 3, height: 4 }, frame(area), 1, LIMITS)).toEqual({ x: 840, y: 76, width: 360, height: 724 })
  })
})

describe('overlayBounds: pane', () => {
  it('is exactly the area it is given, whatever height its content asks for and whatever the anchor', () => {
    const area = { x: 0, y: 104, width: 1200, height: 696 }
    expect(overlayBounds({ kind: 'pane' }, undefined, frame(area), 9999, LIMITS)).toEqual(area)
    expect(overlayBounds({ kind: 'pane' }, { x: 1, y: 2, width: 3, height: 4 }, frame(area), 1, LIMITS)).toEqual(area)
  })

  it('is as wide as one pane of a split window', () => {
    const pane = { x: 600, y: 76, width: 600, height: 724 }
    expect(overlayBounds({ kind: 'pane' }, undefined, frame(pane), 200, LIMITS)).toEqual(pane)
  })
})
